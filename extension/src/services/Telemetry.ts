import { Effect, Option, Ref, Schema, Stream } from "effect";
import { PostHog } from "posthog-node";

import { getExtensionVersion } from "../utils/getExtensionVersion.ts";
import { createStorageKey, Storage } from "./Storage.ts";
import { VsCode } from "./VsCode.ts";

// Public API key (not a secret)
const API_KEY = "phc_wT21gBodGcVJINBFaEQEtRjZjvn1rChAg8hDvCopAFe";

// Create a storage key for the anonymous ID
const ANONYMOUS_ID_KEY = createStorageKey(
  "telemetry.anonymousId",
  Schema.String,
);

/**
 * Get or create an anonymous ID for telemetry tracking.
 * The ID is persisted in global storage and generated once per installation.
 */
export function anonymousId(storage: Storage): Effect.Effect<string, never> {
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
};

/**
 * Telemetry service that respects marimo's telemetry setting and uses PostHog for analytics.
 * Only tracks events when: marimo.telemetry is enabled
 */
export class Telemetry extends Effect.Service<Telemetry>()("Telemetry", {
  dependencies: [Storage.Default],
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const storage = yield* Storage;
    let client: PostHog | undefined;

    // Get initial telemetry setting
    const marimoConfig = yield* code.workspace.getConfiguration("marimo");
    const initialTelemetryEnabled =
      marimoConfig.get<boolean>("telemetry") ?? true;

    // Track telemetry state and client initialization
    const telemetryEnabledRef = yield* Ref.make(initialTelemetryEnabled);
    const clientInitializedRef = yield* Ref.make(false);

    const extVersion = yield* getExtensionVersion();
    const distinctId = yield* anonymousId(storage);

    // Initialize PostHog client (only once when telemetry is enabled)
    const initializeClient = Effect.gen(function* () {
      const telemetryEnabled = yield* Ref.get(telemetryEnabledRef);
      const clientInitialized = yield* Ref.get(clientInitializedRef);

      if (!telemetryEnabled || clientInitialized) {
        return;
      }

      client = new PostHog(API_KEY, {
        host: "https://us.i.posthog.com",
      });
      yield* Ref.set(clientInitializedRef, true);

      // Track extension activation
      client.capture({
        distinctId,
        event: "extension_activated",
        properties: {
          extension_version: Option.getOrElse(extVersion, () => "unknown"),
          app_name: code.env.appName,
          app_host: code.env.appHost,
        },
      });
      yield* Effect.logInfo("Anonymous telemetry enabled");
    });

    // Initialize on startup if enabled
    yield* initializeClient;

    // Subscribe to configuration changes
    yield* code.workspace.configurationChanges().pipe(
      Stream.filter((event) => event.affectsConfiguration("marimo.telemetry")),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const config = yield* code.workspace.getConfiguration("marimo");
          const newValue = config.get<boolean>("telemetry") ?? true;
          const oldValue = yield* Ref.get(telemetryEnabledRef);

          yield* Ref.set(telemetryEnabledRef, newValue);

          // If telemetry was just enabled, initialize client
          if (!oldValue && newValue) {
            yield* initializeClient;
          }

          // If telemetry was just disabled, shutdown PostHog
          if (oldValue && !newValue && client) {
            yield* Effect.promise(async () => client?.shutdown());
            client = undefined;
            yield* Ref.set(clientInitializedRef, false);
          }
        }),
      ),
      Effect.forkScoped,
    );

    // Register finalizer to shutdown PostHog when scope closes
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => client?.shutdown()),
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
          const telemetryEnabled = yield* Ref.get(telemetryEnabledRef);
          if (!telemetryEnabled || !client) {
            return;
          }
          const properties = args[0];

          client.capture({
            distinctId,
            event,
            properties: {
              ...properties,
              extension_version: Option.match(extVersion, {
                onSome: (v) => v,
                onNone: () => "unknown",
              }),
            },
          });
        });
      },

      identify: (properties?: Record<string, unknown>): Effect.Effect<void> =>
        Effect.gen(function* () {
          const telemetryEnabled = yield* Ref.get(telemetryEnabledRef);
          if (!telemetryEnabled || !client) {
            return;
          }

          client.identify({
            distinctId,
            properties,
          });
        }),
    };
  }),
}) {}
