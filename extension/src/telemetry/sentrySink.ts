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
          Effect.catchCause(() => Effect.void),
        ),
    );

    const captureError: SentryAdapter["captureError"] = (error, data) => {
      try {
        const classification = classify(data);
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

function classify(data: Record<string, unknown> | undefined) {
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
        : undefined;
  return { tags, fingerprint };
}
