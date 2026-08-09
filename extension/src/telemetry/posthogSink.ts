import { Effect } from "effect";
import { PostHog as PostHogSdk } from "posthog-node";

// Public API key (not a secret)
const API_KEY = "phc_wT21gBodGcVJINBFaEQEtRjZjvn1rChAg8hDvCopAFe";

export interface PostHogAdapter {
  readonly capture: PostHogSdk["capture"];
}

export interface PostHogClient {
  readonly capture: PostHogSdk["capture"];
  readonly shutdown: PostHogSdk["shutdown"];
}

/** Private PostHog delivery adapter owned by the Telemetry scope. */
export const acquirePostHogAdapter = (
  makeClient: () => PostHogClient = () =>
    new PostHogSdk(API_KEY, {
      host: "https://us.i.posthog.com",
    }),
) =>
  Effect.acquireRelease(Effect.sync(makeClient), (client) =>
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
