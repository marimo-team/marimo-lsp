import * as SentrySDK from "@sentry/node";
import { Effect } from "effect";

// Public DSN (not a secret)
const SENTRY_DSN =
  "https://717e07e6f9831ef39f872ab4a7a63dc2@o4505919839862784.ingest.us.sentry.io/4510382050770944";

export interface SentryAdapter {
  readonly captureError: (error: Error, data?: Record<string, unknown>) => void;
  readonly addBreadcrumb: (
    message: string,
    level: "info" | "warning",
    data?: Record<string, unknown>,
  ) => void;
  readonly setBinaryVersion: (
    server: "ruff" | "ty" | "uv",
    version: string,
  ) => void;
  readonly setLspMode: (mode: "wasm" | "uv" | "configured") => void;
}

export interface SentryAdapterOptions {
  readonly appHost: string;
  readonly appName: string;
  readonly machineId: string;
  readonly extensionVersion: string;
}

/** Private Sentry delivery adapter owned by the Telemetry scope. */
export const acquireSentryAdapter = Effect.fn("telemetry.acquireSentryAdapter")(
  function* (options: SentryAdapterOptions) {
    const scope = new SentrySDK.Scope();
    scope.setTags({
      marimo: "true",
      "editor.appHost": options.appHost,
      "editor.appName": options.appName,
      "extension.version": options.extensionVersion,
    });
    scope.setUser({ id: options.machineId });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const globalScope = SentrySDK.getCurrentScope();
        const previousClient = globalScope.getClient();
        let client;
        try {
          client = SentrySDK.initWithoutDefaultIntegrations({
            dsn: SENTRY_DSN,
            release: `vscode-marimo@${options.extensionVersion}`,
            environment: process.env.NODE_ENV ?? "production",
            skipOpenTelemetrySetup: true,
            normalizeDepth: 8,
            integrations: [
              SentrySDK.linkedErrorsIntegration(),
              SentrySDK.extraErrorDataIntegration(),
            ],
          });
        } finally {
          globalScope.setClient(previousClient);
        }
        if (!client) throw new Error("Sentry failed to initialize");
        try {
          scope.setClient(client);
        } catch (error) {
          void client.close(2000);
          throw error;
        }
        return client;
      }),
      (client) =>
        Effect.promise(() => client.close(2000)).pipe(
          Effect.catchAllCause(() => Effect.void),
        ),
    );

    const captureError: SentryAdapter["captureError"] = (error, data) => {
      try {
        const classification = classifySentryError(error, data);
        scope.captureException(error, {
          captureContext: {
            ...(data ? { extra: data } : {}),
            level: data?.["error.level"] === "fatal" ? "fatal" : "error",
            tags: classification.tags,
            ...(classification.fingerprint
              ? { fingerprint: classification.fingerprint }
              : {}),
          },
        });
      } catch {
        // Telemetry must never affect product behavior.
      }
    };

    const addBreadcrumb: SentryAdapter["addBreadcrumb"] = (
      message,
      level,
      data,
    ) => {
      try {
        scope.addBreadcrumb({ category: "marimo", message, level, data }, 100);
      } catch {
        // Telemetry must never affect product behavior.
      }
    };

    const setBinaryVersion: SentryAdapter["setBinaryVersion"] = (
      server,
      version,
    ) => {
      try {
        scope.setTag(`${server}.version`, version.slice(0, 100));
      } catch {
        // Telemetry must never affect product behavior.
      }
    };

    const setLspMode: SentryAdapter["setLspMode"] = (mode) => {
      try {
        scope.setTag("marimo_lsp.mode", mode);
      } catch {
        // Telemetry must never affect product behavior.
      }
    };

    return { captureError, addBreadcrumb, setBinaryVersion, setLspMode };
  },
);

export function classifySentryError(
  error: Error,
  data: Record<string, unknown> | undefined,
) {
  const tags: Record<string, string> = {};
  for (const key of [
    "error.domain",
    "error.exception_class",
    "error.kind",
    "error.tag",
    "rpc.method",
    "rpc.code",
    "lsp.mode",
  ]) {
    const value = data?.[key];
    if (typeof value === "string" || typeof value === "number") {
      tags[key] = String(value).slice(0, 200);
    }
  }

  const domain = tags["error.domain"];
  const kind = tags["error.kind"];
  const code = tags["rpc.code"];
  const exceptionClass = tags["error.exception_class"];
  const errorTag = tags["error.tag"];
  const commandCause = classifyMarimoCommandCause(error);
  if (commandCause) {
    tags["error.exception_class"] ??= commandCause.exceptionClass;
    tags["error.kind"] ??= `marimo-command.${commandCause.kind}`;
  }
  const fingerprint =
    domain && kind
      ? [
          domain,
          kind,
          ...(code ? [code] : []),
          ...(exceptionClass ? [exceptionClass] : []),
        ]
      : errorTag
        ? ["marimo extension error", errorTag]
        : commandCause
          ? ["marimo command error", commandCause.kind]
          : undefined;
  return { tags, fingerprint };
}

function classifyMarimoCommandCause(
  error: Error,
): { readonly exceptionClass: string; readonly kind: string } | undefined {
  if (error.name !== "MarimoCommandError") {
    return undefined;
  }

  const causes = errorCauseChain(error.cause);
  if (causes.length === 0) return undefined;

  const message = causes.map((cause) => cause.message).join("\n");
  let exceptionClass = "Error";
  for (let index = causes.length - 1; index >= 0; index--) {
    const candidate = nestedExceptionClass(causes[index]);
    if (candidate !== "Error") {
      exceptionClass = candidate;
      break;
    }
  }
  if (message.includes("Kernel bridge exited unexpectedly")) {
    return { exceptionClass, kind: "kernel-bridge-exit" };
  }
  if (
    exceptionClass === "DuplicateCellIdError" ||
    /Cell\s+['"`][^'"`]+['"`]\s+already exists/i.test(message)
  ) {
    return { exceptionClass, kind: "duplicate-cell-id" };
  }
  if (exceptionClass !== "Error") {
    return { exceptionClass, kind: exceptionClass };
  }
  return { exceptionClass, kind: "rpc-error" };
}

function errorCauseChain(value: unknown): Error[] {
  const causes: Error[] = [];
  const seen = new Set<Error>();
  while (value instanceof Error && !seen.has(value)) {
    causes.push(value);
    seen.add(value);
    value = value.cause;
  }
  return causes;
}

function nestedExceptionClass(error: Error): string {
  if (error.name !== "Error" && isSafeClassName(error.name)) return error.name;
  const match = error.message.match(
    /(?:^|\.)\s*([A-Za-z_$][\w$]*(?:Error|Exception)):/,
  );
  return match && isSafeClassName(match[1]) ? match[1] : "Error";
}

function isSafeClassName(value: string): boolean {
  return /^[A-Za-z_$][\w$.-]{0,79}$/.test(value);
}
