import * as SentrySDK from "@sentry/node";
import {
  Cause,
  Effect,
  HashMap,
  Logger,
  LogLevel,
  MutableRef,
  Array as ReadonlyArray,
} from "effect";

// This is a public DSN
const SENTRY_DSN =
  "https://717e07e6f9831ef39f872ab4a7a63dc2@o4505919839862784.ingest.us.sentry.io/4510382050770944";
const SENTRY_MESSAGE = "marimo extension error";

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

            return sanitizeSentryEvent(event);
          },
          beforeBreadcrumb(breadcrumb) {
            if (breadcrumb.category === "marimo") {
              return {
                category: breadcrumb.category,
                level: breadcrumb.level,
                message: breadcrumb.message,
                data: sanitizeTelemetryExtra(breadcrumb.data),
              };
            }
            return {
              category: breadcrumb.category,
              level: breadcrumb.level,
              message: "external breadcrumb",
            };
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
          if (["ruff.version", "ty.version", "uv.version"].includes(key)) {
            SentrySDK.setTag(key, safeToken(value));
          }
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
      const messageStr = messages
        .filter((message): message is string => typeof message === "string")
        .join("\n");

      if (shouldFilterMessage(messageStr)) {
        return;
      }

      // Build extra context with annotations
      const extra: Record<string, unknown> = {};
      let errorTag: string | undefined;
      let errorDomain: string | undefined;
      let errorKind: string | undefined;
      let rpcCode: number | undefined;
      let exceptionClass: string | undefined;
      for (const [key, value] of HashMap.toEntries(opts.annotations)) {
        const safeValue = safeAnnotation(key, value);
        if (safeValue !== undefined) extra[key] = safeValue;
        if (key === "error.tag" && typeof value === "string") {
          errorTag = safeToken(value);
        }
        if (key === "error.domain" && typeof safeValue === "string")
          errorDomain = safeValue;
        if (key === "error.kind" && typeof safeValue === "string")
          errorKind = safeValue;
        if (key === "rpc.code" && typeof safeValue === "number")
          rpcCode = safeValue;
        if (key === "error.exception_class" && typeof safeValue === "string")
          exceptionClass = safeValue;
      }

      // Include cause if present
      if (!Cause.isEmpty(opts.cause)) {
        extra["logger.cause"] = summarizeCause(opts.cause);
      }

      // Splitting the Sentry group by inner failure tag turns coarse
      // "Notebook deserialize failed" buckets into one group per root
      // cause (MarimoClientStartError vs MarimoCommandError vs ...).
      const tags = {
        marimo: "true",
        ...(errorTag ? { "error.tag": errorTag } : {}),
        ...(errorDomain ? { "error.domain": errorDomain } : {}),
        ...(errorKind ? { "error.kind": errorKind } : {}),
        ...(typeof extra["rpc.method"] === "string"
          ? { "rpc.method": extra["rpc.method"] }
          : {}),
        ...(rpcCode === undefined ? {} : { "rpc.code": String(rpcCode) }),
      };
      const fingerprint =
        errorDomain && errorKind
          ? [
              errorDomain,
              errorKind,
              ...(rpcCode === undefined ? [] : [String(rpcCode)]),
              ...(exceptionClass ? [exceptionClass] : []),
            ]
          : errorTag
            ? [SENTRY_MESSAGE, errorTag]
            : undefined;

      if (opts.logLevel === LogLevel.Error) {
        SentrySDK.captureMessage(SENTRY_MESSAGE, {
          extra,
          level: "error",
          tags,
          fingerprint,
        });
      } else if (opts.logLevel === LogLevel.Fatal) {
        SentrySDK.captureMessage(SENTRY_MESSAGE, {
          extra,
          level: "fatal",
          tags,
          fingerprint,
        });
      } else if (opts.logLevel === LogLevel.Warning) {
        SentrySDK.addBreadcrumb({
          category: "marimo",
          message: "marimo extension warning",
          level: "warning",
          data: extra,
        });
      } else if (opts.logLevel === LogLevel.Info) {
        SentrySDK.addBreadcrumb({
          category: "marimo",
          message: "marimo extension info",
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

const SAFE_ANNOTATIONS = new Set([
  "byteCount",
  "cached",
  "cellCount",
  "code",
  "count",
  "error.domain",
  "error.exception_class",
  "error.kind",
  "error.tag",
  "fileType",
  "kind",
  "method",
  "mode",
  "rpc.code",
  "rpc.method",
  "server",
  "service",
  "status",
  "version",
]);

function safeAnnotation(key: string, value: unknown): unknown {
  if (key === "cause" && Cause.isCause(value)) {
    return Cause.isEmpty(value) ? undefined : summarizeCause(value);
  }
  if (!SAFE_ANNOTATIONS.has(key)) return undefined;
  if (key === "code" || key === "rpc.code")
    return typeof value === "number" ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean") return value;
  return typeof value === "string" ? safeToken(value) : undefined;
}

function summarizeCause(cause: Cause.Cause<unknown>): unknown {
  return {
    failures: [...Cause.failures(cause)]
      .slice(0, 3)
      .map((failure) => summarizeError(failure)),
    defects: [...Cause.defects(cause)]
      .slice(0, 3)
      .map((defect) => summarizeError(defect)),
  };
}

function summarizeError(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return { exceptionClass: typeof value };

  const summary: Record<string, unknown> = {
    exceptionClass:
      safeClassName(value._tag) ??
      safeClassName(value.name) ??
      safeClassName(value.constructor?.name) ??
      "Error",
  };
  if (typeof value.code === "number") summary.rpcCode = value.code;
  if (typeof value.line === "number") summary.line = value.line;
  if (typeof value.column === "number") summary.column = value.column;
  return summary;
}

function sanitizeSentryEvent<Event extends SentrySDK.Event>(
  event: Event,
): Event {
  delete event.request;
  delete event.contexts;
  delete event.server_name;
  event.extra = sanitizeTelemetryExtra(event.extra);
  if (event.message !== undefined) event.message = SENTRY_MESSAGE;
  if (event.logentry?.message !== undefined) {
    event.logentry.message = SENTRY_MESSAGE;
  }
  for (const exception of event.exception?.values ?? []) {
    exception.value = SENTRY_MESSAGE;
    exception.type = safeClassName(exception.type) ?? "Error";
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
      delete frame.vars;
      delete frame.filename;
      delete frame.abs_path;
      delete frame.function;
      delete frame.module;
    }
  }
  return event;
}

function sanitizeTelemetryExtra(
  extra: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!extra) return undefined;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) {
    if (key === "cause" || key === "logger.cause") {
      const cause = sanitizeCauseSummary(value);
      if (cause) sanitized[key] = cause;
      continue;
    }
    const safeValue = safeAnnotation(key, value);
    if (safeValue !== undefined) sanitized[key] = safeValue;
  }
  return Object.keys(sanitized).length === 0 ? undefined : sanitized;
}

function sanitizeCauseSummary(value: unknown): unknown {
  if (!isRecord(value)) return undefined;
  const sanitizeItems = (items: unknown) =>
    Array.isArray(items)
      ? items.slice(0, 3).flatMap((item) => {
          if (!isRecord(item)) return [];
          const exceptionClass = safeClassName(item.exceptionClass);
          if (!exceptionClass) return [];
          return [
            {
              exceptionClass,
              ...(typeof item.rpcCode === "number"
                ? { rpcCode: item.rpcCode }
                : {}),
              ...(typeof item.line === "number" ? { line: item.line } : {}),
              ...(typeof item.column === "number"
                ? { column: item.column }
                : {}),
            },
          ];
        })
      : [];
  return {
    failures: sanitizeItems(value.failures),
    defects: sanitizeItems(value.defects),
  };
}

function safeToken(value: string): string {
  return /^[A-Za-z0-9_.$<>: -]{1,100}$/.test(value) ? value : "redacted";
}

function safeClassName(value: unknown): string | undefined {
  return typeof value === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}
