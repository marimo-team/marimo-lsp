import { Effect, Exit, Option, Ref, Schema, Scope, Stream } from "effect";
import type { PostHog } from "posthog-node";

import { type BinarySource } from "../lib/binaryResolution.ts";
import { getExtensionVersion } from "../lib/getExtensionVersion.ts";
import { createStorageKey, Storage } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";
import { acquirePostHogSink } from "./posthogSink.ts";
import { makeSentrySink } from "./sentrySink.ts";

// Create a storage key for the anonymous ID
const ANONYMOUS_ID_KEY = createStorageKey(
  "telemetry.anonymousId",
  Schema.String,
);

/**
 * Get or create an anonymous ID for telemetry tracking.
 * The ID is persisted in global storage and generated once per installation.
 */
function anonymousId(storage: Storage): Effect.Effect<string> {
  return Effect.gen(function* () {
    // Try to get existing ID
    const maybeId = yield* storage.global.get(ANONYMOUS_ID_KEY);
    if (Option.isSome(maybeId)) {
      return maybeId.value;
    }

    // Generate and store new ID
    const newId = crypto.randomUUID();
    yield* storage.global.set(ANONYMOUS_ID_KEY, newId).pipe(
      Effect.ignore, // Ignore errors when storing
    );

    return newId;
  }).pipe(
    Effect.orElseSucceed(() => "unknown"), // Fallback if anything fails
  );
}

type EventMap = {
  executed_command: { command: string; success: boolean };
  new_notebook_created: undefined;
  notebook_opened: { cellCount: number };
  tutorial_opened: { tutorial: string };
  uv_missing: { binType: "Default" | "Configured" | "Discovered" | "Bundled" };
  uv_init: {
    binType: "Default" | "Configured" | "Discovered" | "Bundled";
    version: string;
  };
  uv_install_clicked: undefined;
  lsp_binary_resolved: {
    server: "ruff" | "ty";
    source: BinarySource["_tag"];
    kind?: "configured" | "bundled";
    version: string;
  };
};

/**
 * The single module through which the extension reports product events and
 * errors. Callers invoke its methods unconditionally; whether anything is
 * actually sent is this module's own concern.
 *
 * Consent (the `marimo.telemetry` setting) is read here and nowhere else.
 * The two sinks — PostHog for product events, Sentry for errors — are scoped
 * resources: acquired when consent turns on, flushed and released when it
 * turns off.
 */
export class Telemetry extends Effect.Service<Telemetry>()("Telemetry", {
  dependencies: [Storage.Default],
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const storage = yield* Storage;

    const extensionVersion = Option.getOrElse(
      yield* getExtensionVersion(),
      () => "unknown",
    );
    const distinctId = yield* anonymousId(storage);
    const sentry = makeSentrySink();

    // Consent: the only reader of the marimo.telemetry setting.
    const readConsent = Effect.map(
      code.workspace.getConfiguration("marimo"),
      (config) => config.get<boolean>("telemetry") ?? true,
    );

    const sinksRef = yield* Ref.make(
      Option.none<{
        readonly scope: Scope.CloseableScope;
        readonly posthog: PostHog;
      }>(),
    );

    const acquireSinks = Effect.gen(function* () {
      yield* sentry.acquire({
        appHost: code.env.appHost,
        appName: code.env.appName,
        machineId: code.env.machineId,
        extensionVersion,
      });
      return yield* acquirePostHogSink({
        distinctId,
        extensionVersion,
        appName: code.env.appName,
        appHost: code.env.appHost,
      });
    });

    // Sinks follow consent: acquired into their own scope when consent turns
    // on, and released (flush + close) when it turns off. Only ever invoked
    // sequentially — from construction below, the single watcher fiber, or
    // the teardown finalizer.
    //
    // Telemetry must never be observable outside its dashboards: a sink that
    // fails to acquire or release is logged and dropped, so a broken SDK can
    // neither fail activation nor kill the consent watcher.
    const applyConsent = Effect.fn("Telemetry.applyConsent")(function* (
      enabled: boolean,
    ) {
      const current = yield* Ref.get(sinksRef);
      if (enabled && Option.isNone(current)) {
        const scope = yield* Scope.make();
        const acquired = yield* Effect.exit(Scope.extend(acquireSinks, scope));
        if (Exit.isSuccess(acquired)) {
          yield* Ref.set(
            sinksRef,
            Option.some({ scope, posthog: acquired.value }),
          );
        } else {
          yield* Effect.logWarning("Failed to acquire telemetry sinks").pipe(
            Effect.annotateLogs({ cause: acquired.cause }),
          );
          yield* Effect.ignoreLogged(Scope.close(scope, acquired));
        }
      } else if (!enabled && Option.isSome(current)) {
        yield* Ref.set(sinksRef, Option.none());
        yield* Effect.ignoreLogged(Scope.close(current.value.scope, Exit.void));
      }
    });

    yield* Effect.addFinalizer(() => applyConsent(false));

    yield* applyConsent(yield* readConsent);

    yield* code.workspace.configurationChanges().pipe(
      Stream.filter((event) => event.affectsConfiguration("marimo.telemetry")),
      Stream.mapEffect(() => readConsent),
      Stream.changes,
      Stream.runForEach(applyConsent),
      Effect.forkScoped,
    );

    const capture = <K extends keyof EventMap>(
      event: K,
      ...args: EventMap[K] extends undefined ? [] : [properties: EventMap[K]]
    ): Effect.Effect<void> =>
      Ref.modify(sinksRef, (sinks) => {
        if (Option.isNone(sinks)) return [undefined, sinks] as const;
        const properties = args[0];

        try {
          // Invoke capture inside the atomic Ref modification so consent loss
          // and capture have a single ordering: an event is either accepted
          // before opt-out, or sees the empty sink afterward.
          sinks.value.posthog.capture({
            distinctId,
            event,
            properties: {
              ...properties,
              extension_version: extensionVersion,
            },
          });
        } catch {
          // Telemetry must never affect product behavior.
        }
        return [undefined, sinks] as const;
      });

    return {
      /**
       * Track an event with optional properties
       */
      capture,

      /**
       * Report which binary source was resolved for a language server.
       */
      reportBinaryResolved: (
        server: "ruff" | "ty",
        source: BinarySource,
        version: string,
      ): Effect.Effect<void> =>
        capture("lsp_binary_resolved", {
          server,
          source: source._tag,
          ...("kind" in source ? { kind: source.kind } : {}),
          version,
        }),

      /**
       * Attach ambient context to future error reports, mirroring
       * `Effect.annotateLogs`.
       */
      annotateErrors: (
        annotations: Record<string, string>,
      ): Effect.Effect<void> => sentry.annotateErrors(annotations),

      /**
       * Error logger forwarding Effect log output to the error sink.
       */
      errorLogger: sentry.errorLogger,
    };
  }),
}) {}
