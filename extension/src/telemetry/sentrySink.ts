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

export interface SentryRuntime<Scope, Client, Integration> {
  readonly createScope: () => Scope;
  readonly setTags: (scope: Scope, tags: Record<string, string>) => void;
  readonly setUser: (scope: Scope, user: { readonly id: string }) => void;
  readonly getCurrentClient: () => Client | undefined;
  readonly setCurrentClient: (client: Client | undefined) => void;
  readonly init: (options: {
    readonly dsn: string;
    readonly release: string;
    readonly environment: string;
    readonly skipOpenTelemetrySetup: true;
    readonly normalizeDepth: number;
    readonly integrations: ReadonlyArray<Integration>;
  }) => Client | undefined;
  readonly linkedErrorsIntegration: () => Integration;
  readonly extraErrorDataIntegration: () => Integration;
  readonly setClient: (scope: Scope, client: Client) => void;
  readonly close: (client: Client, timeout: number) => PromiseLike<unknown>;
  readonly captureException: (
    scope: Scope,
    error: Error,
    hint: Parameters<SentrySDK.Scope["captureException"]>[1],
  ) => void;
  readonly addBreadcrumb: (
    scope: Scope,
    breadcrumb: Parameters<SentrySDK.Scope["addBreadcrumb"]>[0],
    maxBreadcrumbs: number,
  ) => void;
  readonly setTag: (scope: Scope, key: string, value: string) => void;
}

type LiveClient = NonNullable<
  ReturnType<typeof SentrySDK.initWithoutDefaultIntegrations>
>;
type LiveIntegration = ReturnType<typeof SentrySDK.linkedErrorsIntegration>;

const SENTRY_RUNTIME_LIVE: SentryRuntime<
  SentrySDK.Scope,
  LiveClient,
  LiveIntegration
> = {
  createScope: () => new SentrySDK.Scope(),
  setTags: (scope, tags) => scope.setTags(tags),
  setUser: (scope, user) => scope.setUser(user),
  getCurrentClient: () => SentrySDK.getCurrentScope().getClient(),
  setCurrentClient: (client) => SentrySDK.getCurrentScope().setClient(client),
  init: (options) =>
    SentrySDK.initWithoutDefaultIntegrations({
      ...options,
      integrations: [...options.integrations],
    }),
  linkedErrorsIntegration: () => SentrySDK.linkedErrorsIntegration(),
  extraErrorDataIntegration: () => SentrySDK.extraErrorDataIntegration(),
  setClient: (scope, client) => scope.setClient(client),
  close: (client, timeout) => client.close(timeout),
  captureException: (scope, error, hint) => scope.captureException(error, hint),
  addBreadcrumb: (scope, breadcrumb, maxBreadcrumbs) =>
    scope.addBreadcrumb(breadcrumb, maxBreadcrumbs),
  setTag: (scope, key, value) => scope.setTag(key, value),
};

/** Private Sentry delivery adapter owned by the Telemetry scope. */
export const makeAcquireSentryAdapter = <Scope, Client, Integration>(
  runtime: SentryRuntime<Scope, Client, Integration>,
) =>
  Effect.fn("telemetry.acquireSentryAdapter")(function* (
    options: SentryAdapterOptions,
  ) {
    const scope = runtime.createScope();
    runtime.setTags(scope, {
      marimo: "true",
      "editor.appHost": options.appHost,
      "editor.appName": options.appName,
      "extension.version": options.extensionVersion,
    });
    runtime.setUser(scope, { id: options.machineId });

    yield* Effect.acquireRelease(
      Effect.sync(() => {
        const previousClient = runtime.getCurrentClient();
        let client;
        try {
          client = runtime.init({
            dsn: SENTRY_DSN,
            release: `vscode-marimo@${options.extensionVersion}`,
            environment: process.env.NODE_ENV ?? "production",
            skipOpenTelemetrySetup: true,
            normalizeDepth: 8,
            integrations: [
              runtime.linkedErrorsIntegration(),
              runtime.extraErrorDataIntegration(),
            ],
          });
        } finally {
          runtime.setCurrentClient(previousClient);
        }
        if (!client) throw new Error("Sentry failed to initialize");
        try {
          runtime.setClient(scope, client);
        } catch (error) {
          void runtime.close(client, 2000);
          throw error;
        }
        return client;
      }),
      (client) =>
        Effect.promise(() => runtime.close(client, 2000)).pipe(
          Effect.catchAllCause(() => Effect.void),
        ),
    );

    const captureError: SentryAdapter["captureError"] = (error, data) => {
      try {
        const classification = classify(data);
        runtime.captureException(scope, error, {
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
        runtime.addBreadcrumb(
          scope,
          { category: "marimo", message, level, data },
          100,
        );
      } catch {
        // Telemetry must never affect product behavior.
      }
    };

    const setBinaryVersion: SentryAdapter["setBinaryVersion"] = (
      server,
      version,
    ) => {
      try {
        runtime.setTag(scope, `${server}.version`, version.slice(0, 100));
      } catch {
        // Telemetry must never affect product behavior.
      }
    };

    const setLspMode: SentryAdapter["setLspMode"] = (mode) => {
      try {
        runtime.setTag(scope, "marimo_lsp.mode", mode);
      } catch {
        // Telemetry must never affect product behavior.
      }
    };

    return { captureError, addBreadcrumb, setBinaryVersion, setLspMode };
  });

export const acquireSentryAdapter =
  makeAcquireSentryAdapter(SENTRY_RUNTIME_LIVE);

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
