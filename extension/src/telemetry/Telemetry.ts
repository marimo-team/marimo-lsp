import { Effect, Exit, Option, Ref, Schema, Scope, Stream } from "effect";
import type { PostHog } from "posthog-node";

import { type BinarySource } from "../lib/binaryResolution.ts";
import { getExtensionVersion } from "../lib/getExtensionVersion.ts";
import { createStorageKey, Storage } from "../platform/Storage.ts";
import { VsCode } from "../platform/VsCode.ts";
import { acquirePostHogSink } from "./posthogSink.ts";
import {
  acquireSentrySink,
  sentryErrorLogger,
  setSentryTag,
} from "./sentrySink.ts";

// Create a storage key for the anonymous ID
const ANONYMOUS_ID_KEY = createStorageKey(
  "telemetry.anonymousId",
  Schema.String,
);

/**
 * Get or create an anonymous ID for telemetry tracking.
 * The ID is persisted in global storage and generated once per installation.
 */
export function anonymousId(storage: Storage): Effect.Effect<string> {
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
    source: "UserConfigured" | "CompanionExtension" | "UvInstalled";
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

    // Consent: the only reader of the marimo.telemetry setting.
    const readConsent = Effect.map(
      code.workspace.getConfiguration("marimo"),
      (config) => config.get<boolean>("telemetry") ?? true,
    );

    const posthogRef = yield* Ref.make(Option.none<PostHog>());
    const sinkScope = yield* Ref.make(Option.none<Scope.CloseableScope>());

    const acquireSinks = Effect.gen(function* () {
      yield* acquireSentrySink({
        appHost: code.env.appHost,
        appName: code.env.appName,
        machineId: code.env.machineId,
        extensionVersion,
      });
      const client = yield* acquirePostHogSink({
        distinctId,
        extensionVersion,
        appName: code.env.appName,
        appHost: code.env.appHost,
      });
      yield* Effect.acquireRelease(
        Ref.set(posthogRef, Option.some(client)),
        () => Ref.set(posthogRef, Option.none()),
      );
    });

    // Sinks follow consent: acquired into their own scope when consent turns
    // on, and released (flush + close) when it turns off. Only ever invoked
    // sequentially — from construction below, the single watcher fiber, or
    // the teardown finalizer.
    const applyConsent = Effect.fn("Telemetry.applyConsent")(function* (
      enabled: boolean,
    ) {
      const current = yield* Ref.get(sinkScope);
      if (enabled && Option.isNone(current)) {
        const scope = yield* Scope.make();
        yield* Scope.extend(acquireSinks, scope);
        yield* Ref.set(sinkScope, Option.some(scope));
      } else if (!enabled && Option.isSome(current)) {
        yield* Ref.set(sinkScope, Option.none());
        yield* Scope.close(current.value, Exit.void);
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

    return {
      /**
       * Track an event with optional properties
       */
      capture<K extends keyof EventMap>(
        event: K,
        ...args: EventMap[K] extends undefined ? [] : [properties: EventMap[K]]
      ): Effect.Effect<void> {
        return Effect.gen(function* () {
          const client = yield* Ref.get(posthogRef);
          if (Option.isNone(client)) {
            return;
          }
          const properties = args[0];

          client.value.capture({
            distinctId,
            event,
            properties: {
              ...properties,
              extension_version: extensionVersion,
            },
          });
        });
      },

      /**
       * Report which binary source was resolved for a language server.
       */
      reportBinaryResolved(
        server: "ruff" | "ty",
        source: BinarySource,
        version: string,
      ): Effect.Effect<void> {
        return this.capture("lsp_binary_resolved", {
          server,
          source: source._tag,
          ...("kind" in source ? { kind: source.kind } : {}),
          version,
        });
      },

      /**
       * Set a tag for filtering error reports.
       */
      setTag: (key: string, value: string): Effect.Effect<void> =>
        setSentryTag(key, value),

      /**
       * Error logger forwarding Effect log output to the error sink.
       */
      errorLogger: sentryErrorLogger,
    };
  }),
}) {}
