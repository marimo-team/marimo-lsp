import { Effect, Layer, Logger } from "effect";

import { Sentry } from "../services/Sentry.ts";

/**
 * Test implementation of Sentry that does nothing
 */
export const TestSentryLive = Layer.succeed(
  Sentry,
  Sentry.make({
    addBreadcrumb: () => Effect.void,
    captureException: () => Effect.void,
    captureMessage: () => Effect.void,
    errorLogger: Logger.none,
    setContext: () => Effect.void,
    setTag: () => Effect.void,
  }),
);
