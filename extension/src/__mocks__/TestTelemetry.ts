import { Effect, Layer, Logger } from "effect";

import { Telemetry } from "../telemetry/Telemetry.ts";

/**
 * Test implementation of Telemetry that does nothing
 */
export const TestTelemetryLive = Layer.succeed(
  Telemetry,
  Telemetry.make({
    capture: () => Effect.void,
    reportBinaryResolved: () => Effect.void,
    annotateErrors: () => Effect.void,
    errorLogger: Logger.none,
  }),
);
