import * as SentrySDK from "@sentry/node";
import { Cause, Effect, HashMap, Logger, LogLevel } from "effect";
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
      // Disable automatic capture of unhandled errors
      integrations: (integrations) => {
        return integrations.filter((integration) => {
          // Filter out integrations that automatically capture unhandled errors
          return (
            integration.name !== "OnUncaughtException" &&
            integration.name !== "OnUnhandledRejection"
          );
        });
      },
      // Only capture errors that originate from this extension
      beforeSend(event) {
        // Filter out errors from other extensions by checking stack traces
        const frames = event.exception?.values?.[0]?.stacktrace?.frames;
        if (frames && frames.length > 0) {
          if (!isMarimoStackTrace(frames)) {
            return null;
          }
        }

        // Filter out errors that contain stack traces from other extensions in the message
        const message =
          event.message ||
          event.exception?.values?.[0]?.value ||
          event.logentry?.message;
        if (message && shouldFilterMessage(message)) {
          return null;
        }

        return event;
      },
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
            tags: {
              marimo: "true",
            },
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
            tags: {
              marimo: "true",
            },
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
        const message = getErrorMessage(opts);

        if (shouldFilterMessage(message)) {
          return;
        }

        if (opts.logLevel === LogLevel.Error) {
          SentrySDK.captureMessage(message, {
            extra: Object.fromEntries(HashMap.toEntries(opts.annotations)),
            level: "error",
            tags: {
              marimo: "true",
            },
          });
        } else if (opts.logLevel === LogLevel.Fatal) {
          SentrySDK.captureMessage(message, {
            extra: Object.fromEntries(HashMap.toEntries(opts.annotations)),
            level: "info",
            tags: {
              marimo: "true",
            },
          });
        } else if (opts.logLevel === LogLevel.Warning) {
          SentrySDK.addBreadcrumb({
            message: message,
            level: "warning",
            data: Object.fromEntries(HashMap.toEntries(opts.annotations)),
          });
        }
      }),
    };
  }),
}) {}

function shouldFilterMessage(message: string) {
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("marimo")) {
    return false;
  }

  // Filter '.vscode/extensions' or '.vscode\extensions'
  return (
    lowerMessage.includes(".vscode/extensions") ||
    lowerMessage.includes(".vscode\\extensions")
  );
}

function isMarimoStackTrace(frames: SentrySDK.StackFrame[]) {
  return frames.some((frame) => frame.filename?.includes("marimo"));
}

function getErrorMessage(opts: Logger.Logger.Options<unknown>) {
  if (opts.cause && !Cause.isEmpty(opts.cause)) {
    return Cause.pretty(opts.cause);
  }
  return prettyMessage(opts.message);
}

function prettyMessage(message: unknown): string {
  if (Array.isArray(message)) {
    return message.map(prettyMessage).join(", ");
  }

  if (typeof message === "object" && message !== null) {
    try {
      return JSON.stringify(message);
    } catch {
      return String(message);
    }
  }

  return String(message);
}
