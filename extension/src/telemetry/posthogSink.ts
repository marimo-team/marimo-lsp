import { Effect } from "effect";
import { PostHog } from "posthog-node";

// Public API key (not a secret)
const API_KEY = "phc_wT21gBodGcVJINBFaEQEtRjZjvn1rChAg8hDvCopAFe";

export interface PostHogSinkOptions {
  readonly distinctId: string;
  readonly extensionVersion: string;
  readonly appName: string;
  readonly appHost: string;
}

/**
 * PostHog sink: product events for the Telemetry facade.
 *
 * Acquiring creates the client and records activation; releasing flushes and
 * shuts it down. The returned client is only valid while the sink's scope is
 * open — the facade drops its reference on release.
 */
export const acquirePostHogSink = Effect.fn("telemetry.acquirePostHogSink")(
  function* (options: PostHogSinkOptions) {
    const client = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new PostHog(API_KEY, {
            host: "https://us.i.posthog.com",
          }),
      ),
      (client) => Effect.promise(async () => client.shutdown()),
    );

    // Track extension activation
    client.capture({
      distinctId: options.distinctId,
      event: "extension_activated",
      properties: {
        extension_version: options.extensionVersion,
        app_name: options.appName,
        app_host: options.appHost,
      },
    });
    yield* Effect.logDebug("Anonymous telemetry enabled");

    return client;
  },
);
