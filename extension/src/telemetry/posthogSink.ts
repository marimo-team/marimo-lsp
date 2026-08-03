import { Effect } from "effect";
import { PostHog } from "posthog-node";

// Public API key (not a secret)
const API_KEY = "phc_wT21gBodGcVJINBFaEQEtRjZjvn1rChAg8hDvCopAFe";

export interface PostHogAdapter {
  readonly capture: PostHog["capture"];
}

/** Private PostHog delivery adapter owned by the Telemetry scope. */
export const acquirePostHogAdapter = Effect.acquireRelease(
  Effect.sync(
    () =>
      new PostHog(API_KEY, {
        host: "https://us.i.posthog.com",
      }),
  ),
  (client) =>
    Effect.promise(() => client.shutdown()).pipe(
      Effect.catchAllCause(() => Effect.void),
    ),
).pipe(
  Effect.map(
    (client): PostHogAdapter => ({
      capture: client.capture.bind(client),
    }),
  ),
);
