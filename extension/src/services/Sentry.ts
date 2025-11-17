import * as SentrySDK from "@sentry/node";
import { Effect, HashMap, Logger, LogLevel } from "effect";
import { getExtensionVersion } from "./HealthService.ts";
import { VsCode } from "./VsCode.ts";

// This is a public DSN
const SENTRY_DSN =
  "https://717e07e6f9831ef39f872ab4a7a63dc2@o4505919839862784.ingest.us.sentry.io/4510382050770944";

/**
 * Sentry service for error tracking and monitoring.
 */
export class Sentry extends Effect.Service<Sentry>()("Sentry", {
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;

    const extensionVersion = yield* getExtensionVersion(code).pipe(
      Effect.catchTag("CouldNotGetInformationError", () =>
        Effect.succeed("unknown"),
      ),
    );

    const config = yield* code.workspace.getConfiguration("marimo");
    const telemetryEnabled = config.get<boolean>("telemetry") ?? true;

    SentrySDK.init({
      dsn: SENTRY_DSN,
      release: `vscode-marimo@${extensionVersion}`,
      environment: process.env.NODE_ENV ?? "production",
      enabled: Boolean(telemetryEnabled),
    });

    // Set global context
    SentrySDK.setTag("editor.appHost", code.env.appHost);
    SentrySDK.setTag("editor.appName", code.env.appName);
    SentrySDK.setTag("extension.version", extensionVersion);
    SentrySDK.setUser({ id: code.env.machineId });

    // Register finalizer to flush Sentry on shutdown
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await SentrySDK.close(2000);
      }),
    );

    return {
      /**
       * Capture an exception (unexpected error)
       */
      captureException: (
        error: unknown,
        context?: Record<string, unknown>,
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          SentrySDK.captureException(error, {
            extra: context,
          });
        }),

      /**
       * Capture a message (expected error or notable event)
       */
      captureMessage: (
        message: string,
        level: "fatal" | "error" | "warning" | "info" | "debug" = "error",
        context?: Record<string, unknown>,
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          SentrySDK.captureMessage(message, {
            level,
            extra: context,
          });
        }),

      /**
       * Add a breadcrumb for tracing user actions
       */
      addBreadcrumb: (breadcrumb: {
        category?: string;
        message: string;
        level?: "fatal" | "error" | "warning" | "info" | "debug";
        data?: Record<string, unknown>;
      }): Effect.Effect<void> =>
        Effect.sync(() => {
          SentrySDK.addBreadcrumb({
            ...breadcrumb,
            timestamp: Date.now() / 1000,
          });
        }),

      /**
       * Set additional context/tags
       */
      setContext: (
        name: string,
        context: Record<string, unknown>,
      ): Effect.Effect<void> =>
        Effect.sync(() => {
          SentrySDK.setContext(name, context);
        }),

      /**
       * Set a tag for filtering in Sentry
       */
      setTag: (key: string, value: string): Effect.Effect<void> =>
        Effect.sync(() => {
          SentrySDK.setTag(key, value);
        }),

      /**
       * Error logger
       */
      errorLogger: Logger.make((opts) => {
        if (opts.logLevel === LogLevel.Error) {
          SentrySDK.captureMessage(String(opts.message), {
            extra: Object.fromEntries(HashMap.toEntries(opts.annotations)),
          });
        } else if (opts.logLevel === LogLevel.Fatal) {
          SentrySDK.captureMessage(String(opts.message), {
            extra: Object.fromEntries(HashMap.toEntries(opts.annotations)),
          });
        } else if (opts.logLevel === LogLevel.Warning) {
          SentrySDK.addBreadcrumb({
            message: String(opts.message),
            level: "warning",
            data: Object.fromEntries(HashMap.toEntries(opts.annotations)),
          });
        }
      }),
    };
  }),
}) {}
