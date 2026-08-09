import {
  Cause,
  Effect,
  HashMap,
  Inspectable,
  Logger,
  LogLevel,
  Option,
  Schema,
  Array as ReadonlyArray,
} from "effect";
import type * as vscode from "vscode";

import { type BinarySource } from "../lib/binaryResolution.ts";
import { getExtensionVersion } from "../lib/getExtensionVersion.ts";
import { createStorageKey, Storage } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";
import { acquirePostHogAdapter, type PostHogAdapter } from "./posthogSink.ts";
import { acquireSentryAdapter, type SentryAdapter } from "./sentrySink.ts";

const ANONYMOUS_ID_KEY = createStorageKey(
  "telemetry.anonymousId",
  Schema.String,
);

type ResolvedBinary =
  | {
      readonly server: "uv";
      readonly source: "Default" | "Configured" | "Discovered" | "Bundled";
      readonly version: string;
    }
  | {
      readonly server: "ruff" | "ty";
      readonly resolved: BinarySource;
      readonly version: string;
    };

const NOOP_SENTRY: SentryAdapter = {
  captureError() {},
  addBreadcrumb() {},
  setBinaryVersion() {},
  setLspMode() {},
};

const NOOP_POSTHOG: PostHogAdapter = {
  capture() {},
};

/**
 * The extension's single telemetry runtime.
 *
 * Marimo consent is read once at activation. VS Code's TelemetryLogger remains
 * responsible for its global usage/error gates and for cleaning all caller
 * data before the private PostHog and Sentry adapters receive it.
 */
export function makeTelemetry(
  vendors: {
    readonly acquireSentry: typeof acquireSentryAdapter;
    readonly acquirePostHog: typeof acquirePostHogAdapter;
  } = {
    acquireSentry: acquireSentryAdapter,
    acquirePostHog: acquirePostHogAdapter,
  },
) {
  return Effect.gen(function* () {
    const code = yield* VsCode;
    const config = yield* code.workspace.getConfiguration("marimo");
    const enabled = config.get<boolean>("telemetry") ?? true;
    if (!enabled) return disabledTelemetry();

    const storage = yield* Storage;
    const extensionVersion = Option.getOrElse(
      yield* getExtensionVersion(),
      () => "unknown",
    );
    const distinctId = yield* anonymousId(storage);

    const adapters = {
      sentry: NOOP_SENTRY,
      posthog: NOOP_POSTHOG,
    };
    const sender = makeTelemetrySender(adapters, distinctId);
    const maybeLogger = yield* code.env
      .createTelemetryLogger(sender, {
        // Effect errors are reported deliberately through errorLogger below.
        // Letting VS Code forward unhandled extension-host errors as well
        // duplicates those reports and captures unactionable cleanup failures
        // from dependencies such as vscode-languageclient.
        ignoreUnhandledErrors: true,
        additionalCommonProperties: {
          extension_version: extensionVersion,
          app_name: code.env.appName,
          app_host: code.env.appHost,
        },
      })
      .pipe(
        Effect.map(Option.some),
        Effect.catchAllCause((cause) =>
          Effect.logWarning("Failed to initialize VS Code telemetry").pipe(
            Effect.annotateLogs({ cause }),
            Effect.as(Option.none<vscode.TelemetryLogger>()),
          ),
        ),
      );
    if (Option.isNone(maybeLogger)) return disabledTelemetry();
    const logger = maybeLogger.value;

    adapters.sentry = yield* vendors
      .acquireSentry({
        appHost: code.env.appHost,
        appName: code.env.appName,
        machineId: code.env.machineId,
        extensionVersion,
      })
      .pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning("Failed to initialize Sentry telemetry").pipe(
            Effect.annotateLogs({ cause }),
            Effect.as(NOOP_SENTRY),
          ),
        ),
      );
    adapters.posthog = yield* vendors
      .acquirePostHog()
      .pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning("Failed to initialize PostHog telemetry").pipe(
            Effect.annotateLogs({ cause }),
            Effect.as(NOOP_POSTHOG),
          ),
        ),
      );

    const errorLogger = makeEffectErrorLogger(logger);

    const usage = (event: string, data?: Record<string, unknown>) =>
      Effect.sync(() =>
        ignoreTelemetryError(() => logger.logUsage(event, data)),
      );

    const binaryResolved = (binary: ResolvedBinary): Effect.Effect<void> =>
      Effect.sync(() => {
        ignoreTelemetryError(() => {
          logger.logError("marimo.binary.resolved", {
            server: binary.server,
            version: binary.version,
          });
        });
        ignoreTelemetryError(() => {
          if (binary.server === "uv") {
            logger.logUsage("uv_init", {
              binType: binary.source,
              version: binary.version,
            });
          } else {
            logger.logUsage("lsp_binary_resolved", {
              server: binary.server,
              source: binary.resolved._tag,
              ...("kind" in binary.resolved
                ? { kind: binary.resolved.kind }
                : {}),
              version: binary.version,
            });
          }
        });
      });

    const lspModeSelected = (
      mode: "wasm" | "uv" | "configured",
    ): Effect.Effect<void> =>
      Effect.sync(() => adapters.sentry.setLspMode(mode));

    const lspStarted = (
      mode: "wasm" | "uv" | "configured",
    ): Effect.Effect<void> => usage("marimo_lsp_started", { mode });

    yield* usage("extension_activated");
    return {
      commandExecuted: (command: string, success: boolean) =>
        usage("executed_command", { command, success }),
      notebookCreated: () => usage("new_notebook_created"),
      notebookOpened: (cellCount: number) =>
        usage("notebook_opened", { cellCount }),
      tutorialOpened: (tutorial: string) =>
        usage("tutorial_opened", { tutorial }),
      uvMissing: (
        binType: "Default" | "Configured" | "Discovered" | "Bundled",
      ) => usage("uv_missing", { binType }),
      uvInstallClicked: () => usage("uv_install_clicked"),
      binaryResolved,
      lspModeSelected,
      lspStarted,
      errorLogger,
    };
  });
}

export class Telemetry extends Effect.Service<Telemetry>()("Telemetry", {
  dependencies: [Storage.Default],
  scoped: makeTelemetry(),
}) {}

function disabledTelemetry() {
  return {
    commandExecuted: (_command: string, _success: boolean) => Effect.void,
    notebookCreated: () => Effect.void,
    notebookOpened: (_cellCount: number) => Effect.void,
    tutorialOpened: (_tutorial: string) => Effect.void,
    uvMissing: (
      _binType: "Default" | "Configured" | "Discovered" | "Bundled",
    ) => Effect.void,
    uvInstallClicked: () => Effect.void,
    binaryResolved: (_binary: ResolvedBinary) => Effect.void,
    lspModeSelected: (_mode: "wasm" | "uv" | "configured") => Effect.void,
    lspStarted: (_mode: "wasm" | "uv" | "configured") => Effect.void,
    errorLogger: Logger.none,
  };
}

function makeTelemetrySender(
  adapters: {
    readonly sentry: SentryAdapter;
    readonly posthog: PostHogAdapter;
  },
  distinctId: string,
): vscode.TelemetrySender {
  return {
    sendEventData(eventName, data) {
      const event = unprefixEventName(eventName);
      if (event === "marimo.log.info") {
        adapters.sentry.addBreadcrumb(String(data?.message ?? ""), "info");
        return;
      }
      if (event === "marimo.log.warning") {
        adapters.sentry.addBreadcrumb(String(data?.message ?? ""), "warning");
        return;
      }
      if (event === "marimo.binary.resolved") {
        const server = data?.server;
        const version = data?.version;
        if (
          (server === "uv" || server === "ruff" || server === "ty") &&
          typeof version === "string"
        ) {
          adapters.sentry.setBinaryVersion(server, version);
        }
        return;
      }
      ignoreTelemetryError(() => {
        adapters.posthog.capture({ distinctId, event, properties: data });
      });
    },
    sendErrorData(error, data) {
      adapters.sentry.captureError(restoreErrorCause(error, data), data);
    },
  };
}

function restoreErrorCause(
  error: Error,
  data: Record<string, unknown> | undefined,
): Error {
  const cause = asRecord(data?.cause);
  const summaries = [
    ...(Array.isArray(cause?.failures) ? cause.failures : []),
    ...(Array.isArray(cause?.defects) ? cause.defects : []),
  ];
  const primary = summaries.find(
    (summary) =>
      asRecord(summary)?.name === error.name ||
      asRecord(summary)?.message === error.message,
  );
  const restoredCause = errorFromSummary(asRecord(primary)?.cause);
  if (!restoredCause) return error;

  const restored = new Error(error.message, { cause: restoredCause });
  copyErrorFields(restored, asRecord(primary) ?? {});
  copyErrorFields(restored, error);
  restored.name = error.name;
  restored.stack = error.stack;
  return restored;
}

function errorFromSummary(value: unknown): Error | undefined {
  const summary = asRecord(value);
  if (!summary || typeof summary.message !== "string") return undefined;

  const cause = errorFromSummary(summary.cause);
  const error = new Error(summary.message, cause ? { cause } : undefined);
  copyErrorFields(error, summary);
  if (typeof summary.name === "string") error.name = summary.name;
  if (typeof summary.stack === "string") error.stack = summary.stack;
  return error;
}

function copyErrorFields(target: Error, source: object): void {
  for (const [key, value] of Object.entries(source)) {
    if (key !== "cause") Object.assign(target, { [key]: value });
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

function makeEffectErrorLogger(logger: vscode.TelemetryLogger) {
  return Logger.make((options) => {
    try {
      const messages = ReadonlyArray.ensure(options.message);
      const message = messages
        .filter((item): item is string => typeof item === "string")
        .join("\n");
      const cause = findCause(options.cause, options.annotations, messages);
      if (!Cause.isEmpty(cause) && Cause.isInterruptedOnly(cause)) return;

      if (
        options.logLevel === LogLevel.Error ||
        options.logLevel === LogLevel.Fatal
      ) {
        const data = logData(options.annotations, cause);
        logger.logError(errorFromCause(cause, message), {
          ...data,
          "error.level":
            options.logLevel === LogLevel.Fatal ? "fatal" : "error",
        });
      } else if (options.logLevel === LogLevel.Warning) {
        logger.logError("marimo.log.warning", { message });
      } else if (options.logLevel === LogLevel.Info) {
        logger.logError("marimo.log.info", { message });
      }
    } catch {
      // Logging must not be able to fail an application fiber.
    }
  }).pipe(
    Logger.filterLogLevel(
      (level) =>
        level === LogLevel.Info ||
        level === LogLevel.Warning ||
        level === LogLevel.Error ||
        level === LogLevel.Fatal,
    ),
    Logger.map((): void => undefined),
  );
}

function findCause(
  loggerCause: Cause.Cause<unknown>,
  annotations: HashMap.HashMap<string, unknown>,
  messages: ReadonlyArray<unknown>,
): Cause.Cause<unknown> {
  if (!Cause.isEmpty(loggerCause)) return loggerCause;
  for (const [key, value] of HashMap.toEntries(annotations)) {
    if (key === "cause" && Cause.isCause(value)) return value;
  }
  return messages.find(Cause.isCause) ?? Cause.empty;
}

function logData(
  annotations: HashMap.HashMap<string, unknown>,
  cause: Cause.Cause<unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of HashMap.toEntries(annotations)) {
    if (key === "cause" && Cause.isCause(value)) continue;
    data[key] = diagnosticValue(value);
  }
  if (!Cause.isEmpty(cause)) data.cause = summarizeCause(cause);
  return data;
}

function errorFromCause(cause: Cause.Cause<unknown>, message: string): Error {
  const values = [...Cause.failures(cause), ...Cause.defects(cause)];
  const error = values.find((value): value is Error => value instanceof Error);
  if (error) {
    const needsMessage =
      error.message.trim().length === 0 ||
      error.message === "An error has occurred";
    if (!message || !needsMessage) return error;
    const enriched = new Error(message, { cause: error.cause });
    enriched.name = error.name;
    enriched.stack = error.stack?.replace(
      /^.*?(?=\n|$)/,
      `${error.name}: ${message}`,
    );
    return enriched;
  }

  const fallback = new Error(message || describeUnknown(values[0]));
  fallback.name = values.length > 0 ? "UnknownFailure" : "EffectLogError";
  return fallback;
}

function summarizeCause(cause: Cause.Cause<unknown>) {
  return {
    pretty: Cause.pretty(cause, { renderErrorCause: true }),
    interrupted: Cause.isInterrupted(cause),
    failures: [...Cause.failures(cause)].slice(0, 5).map(summarizeFailure),
    defects: [...Cause.defects(cause)].slice(0, 5).map(summarizeFailure),
  };
}

function summarizeFailure(value: unknown, depth = 0): unknown {
  if (!(value instanceof Error)) return diagnosticValue(value, depth + 1);

  const summary: Record<string, unknown> = {
    name: value.name,
    message: value.message,
    stack: value.stack,
  };
  if (depth < 4 && value.cause !== undefined) {
    summary.cause = summarizeFailure(value.cause, depth + 1);
  }
  if (depth < 4) {
    for (const [key, field] of Object.entries(value)) {
      if (key === "cause" || key in summary) continue;
      summary[key] = diagnosticValue(field, depth + 1);
    }
  }
  return summary;
}

function diagnosticValue(value: unknown, depth = 0): unknown {
  if (value instanceof Error) return summarizeFailure(value, depth);
  if (Cause.isCause(value)) return summarizeCause(value);
  if (depth >= 4) return describeUnknown(value);
  try {
    return Inspectable.toJSON(value);
  } catch {
    return describeUnknown(value);
  }
}

function describeUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (
    value === undefined ||
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  return Object.prototype.toString.call(value);
}

function unprefixEventName(eventName: string): string {
  const separator = eventName.indexOf("/");
  return separator === -1 ? eventName : eventName.slice(separator + 1);
}

function ignoreTelemetryError(action: () => void): void {
  try {
    action();
  } catch {
    // Telemetry is best-effort.
  }
}

function anonymousId(storage: Storage): Effect.Effect<string> {
  return Effect.gen(function* () {
    const maybeId = yield* storage.global.get(ANONYMOUS_ID_KEY);
    if (Option.isSome(maybeId)) return maybeId.value;

    const newId = crypto.randomUUID();
    yield* storage.global.set(ANONYMOUS_ID_KEY, newId).pipe(Effect.ignore);
    return newId;
  }).pipe(Effect.orElseSucceed(() => "unknown"));
}
