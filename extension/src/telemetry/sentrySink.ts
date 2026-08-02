import * as SentrySDK from "@sentry/node";
import {
  Cause,
  Effect,
  HashMap,
  Inspectable,
  Logger,
  LogLevel,
  MutableRef,
  Array as ReadonlyArray,
} from "effect";

// This is a public DSN
const SENTRY_DSN =
  "https://717e07e6f9831ef39f872ab4a7a63dc2@o4505919839862784.ingest.us.sentry.io/4510382050770944";

export interface SentrySinkOptions {
  readonly appHost: string;
  readonly appName: string;
  readonly machineId: string;
  readonly extensionVersion: string;
}

/**
 * Sentry sink: error reporting for the Telemetry facade.
 *
 * Acquiring initializes the SDK; releasing first disables this sink, then
 * flushes and closes it. Annotation and logger calls check the sink's active
 * state, so callers never need to check consent.
 */
export function makeSentrySink() {
  const active = MutableRef.make(false);

  const acquire = Effect.fn("telemetry.acquireSentrySink")(function* (
    options: SentrySinkOptions,
  ) {
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        SentrySDK.init({
          dsn: SENTRY_DSN,
          release: `vscode-marimo@${options.extensionVersion}`,
          environment: process.env.NODE_ENV ?? "production",
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
        }),
      ),
      () =>
        Effect.gen(function* () {
          MutableRef.set(active, false);
          yield* Effect.promise(async () => {
            await SentrySDK.close(2000);
          });
        }),
    );

    // Set global context only after the close finalizer has been installed.
    // If any SDK call throws, acquiring the surrounding scope still releases
    // the partially initialized client.
    SentrySDK.setTag("editor.appHost", options.appHost);
    SentrySDK.setTag("editor.appName", options.appName);
    SentrySDK.setTag("extension.version", options.extensionVersion);
    SentrySDK.setUser({ id: options.machineId });
    MutableRef.set(active, true);
  });

  /**
   * Attach ambient context (Sentry tags) to future error reports. A no-op
   * while the sink is released.
   */
  const annotateErrors = (annotations: Record<string, string>) =>
    Effect.sync(() => {
      if (!MutableRef.get(active)) return;
      try {
        for (const [key, value] of Object.entries(annotations)) {
          SentrySDK.setTag(key, value);
        }
      } catch {
        // Telemetry must never affect product behavior.
      }
    });

  /**
   * Error logger forwarding Effect log output to Sentry. A no-op while the
   * sink is released.
   */
  const errorLogger = Logger.make((opts) => {
    if (!MutableRef.get(active)) return;

    try {
      const messages = ReadonlyArray.ensure(opts.message);
      const messageStr = messages.map(formatValue).join("\n");

      if (shouldFilterMessage(messageStr)) {
        return;
      }

      // Build extra context with annotations
      const extra: Record<string, unknown> = {};
      let errorTag: string | undefined;
      for (const [key, value] of HashMap.toEntries(opts.annotations)) {
        extra[key] = structuredMessage(value);
        if (key === "error.tag" && typeof value === "string") {
          errorTag = value;
        }
        if (Cause.isCause(value) && !Cause.isEmpty(value)) {
          extra[`${key}.pretty`] = Cause.pretty(value, {
            renderErrorCause: true,
          });
        }
      }

      // Include cause if present
      if (!Cause.isEmpty(opts.cause)) {
        extra["logger.cause"] = Cause.pretty(opts.cause, {
          renderErrorCause: true,
        });
      }

      // Splitting the Sentry group by inner failure tag turns coarse
      // "Notebook deserialize failed" buckets into one group per root
      // cause (MarimoClientStartError vs MarimoCommandError vs ...).
      const tags = {
        marimo: "true",
        ...(errorTag ? { "error.tag": errorTag } : {}),
      };
      const fingerprint = errorTag ? [messageStr, errorTag] : undefined;

      if (opts.logLevel === LogLevel.Error) {
        SentrySDK.captureMessage(messageStr, {
          extra,
          level: "error",
          tags,
          fingerprint,
        });
      } else if (opts.logLevel === LogLevel.Fatal) {
        SentrySDK.captureMessage(messageStr, {
          extra,
          level: "fatal",
          tags,
          fingerprint,
        });
      } else if (opts.logLevel === LogLevel.Warning) {
        SentrySDK.addBreadcrumb({
          message: messageStr,
          level: "warning",
          data: extra,
        });
      } else if (opts.logLevel === LogLevel.Info) {
        SentrySDK.addBreadcrumb({
          message: messageStr,
          level: "info",
          data: extra,
        });
      }
    } catch {
      // A reporting SDK failure must not break logging or application fibers.
    }
  });

  return { acquire, annotateErrors, errorLogger } as const;
}

function shouldFilterMessage(message: string) {
  const lowerMessage = message.toLowerCase();
  if (lowerMessage.includes("marimo")) {
    return false;
  }

  // Filter noise from other extensions:
  // - '.vscode/extensions' or '.vscode\extensions' paths
  // - the Augment AI extension (AugmentExtensionSidecar / augmentcode.com),
  //   which dominates this project's Sentry volume
  return (
    lowerMessage.includes(".vscode/extensions") ||
    lowerMessage.includes(".vscode\\extensions") ||
    lowerMessage.includes("augmentextensionsidecar") ||
    lowerMessage.includes("augmentcode")
  );
}

function isMarimoStackTrace(frames: SentrySDK.StackFrame[]) {
  return frames.some((frame) => frame.filename?.includes("marimo"));
}

/**
 * Convert a value to a JSON-serializable form suitable for Sentry's extra data.
 *
 * Sentry truncates nested objects at ~3 levels deep, so complex Effect types
 * (Cause, TaggedErrors with nested fields) get rendered as `[Array]`/`[Object]`.
 * We flatten these to strings to ensure full visibility in Sentry.
 */
function structuredMessage(u: unknown): unknown {
  switch (typeof u) {
    case "bigint":
    case "function":
    case "symbol":
      return String(u);
    default: {
      const json = Inspectable.toJSON(u);
      // If toJSON produced an object, stringify it to avoid Sentry depth truncation
      if (json !== null && typeof json === "object") {
        try {
          return Inspectable.format(json);
        } catch {
          // oxlint-disable-next-line typescript/no-base-to-string
          return String(u);
        }
      }
      return json;
    }
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
    // oxlint-disable-next-line typescript/no-base-to-string
    return String(value);
  }
}
