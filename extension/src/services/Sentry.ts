import * as SentrySDK from "@sentry/node";
import {
  Cause,
  Effect,
  HashMap,
  Inspectable,
  Logger,
  LogLevel,
  Option,
  Array as ReadonlyArray,
} from "effect";
import { getExtensionVersion } from "../utils/getExtensionVersion.ts";
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

    const extensionVersion = Option.getOrElse(
      yield* getExtensionVersion(),
      () => "unknown",
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
        const messages = ReadonlyArray.ensure(opts.message);
        const messageStr = messages.map(formatValue).join("\n");

        if (shouldFilterMessage(messageStr)) {
          return;
        }

        // Build extra context with annotations
        const extra: Record<string, unknown> = {};
        for (const [key, value] of HashMap.toEntries(opts.annotations)) {
          extra[key] = structuredMessage(value);
        }

        // Include cause if present
        if (!Cause.isEmpty(opts.cause)) {
          extra.cause = Cause.pretty(opts.cause, { renderErrorCause: true });
        }

        if (opts.logLevel === LogLevel.Error) {
          SentrySDK.captureMessage(messageStr, {
            extra,
            level: "error",
            tags: { marimo: "true" },
          });
        } else if (opts.logLevel === LogLevel.Fatal) {
          SentrySDK.captureMessage(messageStr, {
            extra,
            level: "fatal",
            tags: { marimo: "true" },
          });
        } else if (opts.logLevel === LogLevel.Warning) {
          SentrySDK.addBreadcrumb({
            message: messageStr,
            level: "warning",
            data: extra,
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
/**
 * Convert a value to a JSON-serializable form (inspired by LiveStore's structuredMessage)
 */
function structuredMessage(u: unknown): unknown {
  switch (typeof u) {
    case "bigint":
    case "function":
    case "symbol":
      return String(u);
    default:
      return Inspectable.toJSON(u);
  }
}

/**
 * Format a value as a string for Sentry
 */
function formatValue(value: unknown) {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  try {
    return JSON.stringify(structuredMessage(value));
  } catch {
    return String(value);
  }
}
