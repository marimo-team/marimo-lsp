import { Effect, Option, Schema } from "effect";
import { PostHog } from "posthog-node";
import { getExtensionVersion } from "./HealthService.ts";
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

/**
 * Telemetry service that respects VSCode's telemetry settings and uses PostHog for analytics.
 * Only tracks events when: VSCode telemetry is enabled (respects telemetry.telemetryLevel setting)
 */
export class Telemetry extends Effect.Service<Telemetry>()("Telemetry", {
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const storage = yield* Storage;
    let client: PostHog | undefined;

    // Initialize PostHog client if telemetry is enabled
    const initialize = Effect.gen(function* () {
      // Check VSCode telemetry setting
      const telemetryConfig =
        yield* code.workspace.getConfiguration("telemetry");
      const telemetryLevel = telemetryConfig.get<string>("telemetryLevel");

      // Respect VSCode telemetry settings
      // Possible values: "all", "error", "crash", "off"
      if (telemetryLevel === "off" || telemetryLevel === "crash") {
        return Effect.void;
      }

      client = new PostHog(API_KEY, {
        host: "https://us.i.posthog.com",
      });

      return Effect.void;
    });

    const extensionVersion = yield* getExtensionVersion(code);
    const distinctId = yield* anonymousId(storage);

    yield* initialize;

    // Register finalizer to shutdown PostHog when scope closes
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => client?.shutdown()),
    );

    // Track extension activation
    if (client) {
      client.capture({
        distinctId,
        event: "extension_activated",
        properties: {
          $lib: "vscode-extension",
          $lib_version: extensionVersion,
        },
      });
    }

    return {
      /**
       * Track an event with optional properties
       */
      capture: (event: string, properties?: Record<string, unknown>) => {
        return Effect.sync(() => {
          if (!client) {
            return;
          }

          client.capture({
            distinctId,
            event,
            properties: {
              ...properties,
              $lib: "vscode-extension",
              $lib_version: extensionVersion,
            },
          });
        });
      },

      identify: (properties?: Record<string, unknown>) =>
        Effect.sync(() => {
          if (!client) {
            return;
          }

          client.identify({
            distinctId,
            properties,
          });
        }),
    };
  }),
  dependencies: [VsCode.Default, Storage.Default],
}) {}
