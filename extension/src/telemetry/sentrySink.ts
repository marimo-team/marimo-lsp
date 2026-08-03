import * as SentrySDK from "@sentry/node";
import {
  Cause,
  Effect,
  HashMap,
  Logger,
  LogLevel,
  MutableRef,
  Redacted,
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
            if (breadcrumb.category === "marimo") return breadcrumb;
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
      for (const [key, value] of HashMap.toEntries(opts.annotations)) {
        const safeValue = safeAnnotation(key, value);
        if (safeValue !== undefined) extra[key] = safeValue;
        if (key === "error.tag" && typeof value === "string") {
          errorTag = safeToken(value);
        }
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
      };
      const fingerprint = errorTag ? [SENTRY_MESSAGE, errorTag] : undefined;

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
  "error.tag",
  "fileType",
  "kind",
  "method",
  "mode",
  "server",
  "service",
  "status",
  "version",
]);

function safeAnnotation(key: string, value: unknown): unknown {
  if (Cause.isCause(value)) {
    return Cause.isEmpty(value) ? undefined : summarizeCause(value);
  }
  if (!SAFE_ANNOTATIONS.has(key)) return undefined;
  if (key === "code") return typeof value === "number" ? value : undefined;
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

function summarizeError(
  value: unknown,
  seen = new Set<object>(),
  depth = 0,
): Record<string, unknown> {
  if (!isRecord(value)) return { exceptionClass: typeof value };
  if (seen.has(value) || depth >= 4) return { exceptionClass: "NestedError" };
  seen.add(value);

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

  if (value._tag === "MarimoCommandError") {
    const command = Redacted.isRedacted(value.command)
      ? Redacted.value(value.command)
      : value.command;
    if (isRecord(command) && isRecord(command.params)) {
      const rpc = command.params;
      if (typeof rpc.method === "string")
        summary.method = safeToken(rpc.method);
      Object.assign(summary, rpcMetadata(rpc.params));
    }
  }

  const traceback = [
    ...sanitizeTraceback(value.stack),
    ...(isRecord(value.data) ? sanitizeTraceback(value.data.traceback) : []),
  ].slice(0, 12);
  if (traceback.length > 0) summary.traceback = traceback;
  if (isRecord(value.cause)) {
    summary.cause = summarizeError(value.cause, seen, depth + 1);
  }
  return summary;
}

function rpcMetadata(value: unknown): Record<string, unknown> {
  let byteCount = 0;
  let cellCount: number | undefined;
  let fileType: string | undefined;
  const seen = new Set<object>();

  const visit = (current: unknown, key = ""): void => {
    if (typeof current === "string") {
      if (/^(?:code|contents?|source)$/i.test(key)) {
        byteCount += Buffer.byteLength(current);
      } else if (/^(?:filename|notebookUri|path|uri)$/i.test(key)) {
        fileType = /\.([A-Za-z0-9]{1,10})(?:[?#].*)?$/.exec(current)?.[1];
      }
      return;
    }
    if (!current || typeof current !== "object" || seen.has(current)) return;
    seen.add(current);
    if (Array.isArray(current)) {
      if (/^(?:cells|codes)$/i.test(key)) cellCount = current.length;
      for (const item of current) visit(item, key === "codes" ? "code" : key);
      return;
    }
    for (const [childKey, child] of Object.entries(current))
      visit(child, childKey);
  };
  visit(value);
  return {
    ...(byteCount > 0 ? { byteCount } : {}),
    ...(cellCount === undefined ? {} : { cellCount }),
    ...(fileType ? { fileType: fileType.toLowerCase() } : {}),
  };
}

function sanitizeSentryEvent<Event extends SentrySDK.Event>(
  event: Event,
): Event {
  delete event.request;
  delete event.contexts;
  delete event.server_name;
  for (const exception of event.exception?.values ?? []) {
    exception.value = safeClassName(exception.type) ?? "marimo extension error";
    for (const frame of exception.stacktrace?.frames ?? []) {
      delete frame.pre_context;
      delete frame.context_line;
      delete frame.post_context;
      delete frame.vars;
      frame.filename = frame.filename?.split(/[\\/]/).at(-1);
      if (frame.abs_path) frame.abs_path = "redacted";
    }
  }
  return event;
}

interface SafeTracebackFrame {
  readonly function?: string;
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
}

function sanitizeTraceback(value: unknown): SafeTracebackFrame[] {
  if (typeof value === "string") {
    const frames: SafeTracebackFrame[] = [];
    for (const line of value.split("\n")) {
      const js = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/.exec(line);
      if (js) {
        frames.push({
          ...(js[1] ? { function: safeToken(js[1]) } : {}),
          file: basename(js[2]),
          line: Number(js[3]),
          column: Number(js[4]),
        });
        continue;
      }
      const python = /^\s*File "(.+)", line (\d+), in (.+)$/.exec(line);
      if (python) {
        frames.push({
          function: safeToken(python[3]),
          file: basename(python[1]),
          line: Number(python[2]),
        });
      }
    }
    return frames;
  }
  if (Array.isArray(value)) return value.flatMap(sanitizeTraceback);
  if (!isRecord(value)) return [];

  const path = [value.filename, value.file, value.path].find(
    (item): item is string => typeof item === "string",
  );
  const fn = [value.function, value.functionName, value.name].find(
    (item): item is string => typeof item === "string",
  );
  const line = typeof value.line === "number" ? value.line : undefined;
  const column = typeof value.column === "number" ? value.column : undefined;
  if (!path && !fn && line === undefined && column === undefined) return [];
  return [
    {
      ...(fn ? { function: safeToken(fn) } : {}),
      ...(path ? { file: basename(path) } : {}),
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    },
  ];
}

function basename(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? "unknown";
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
