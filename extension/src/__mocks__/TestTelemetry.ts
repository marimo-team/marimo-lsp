import { Effect, Layer } from "effect";

import { Telemetry } from "../services/Telemetry.ts";

/**
 * Test implementation of Telemetry that does nothing
 */
export const TestTelemetryLive = Layer.succeed(
  Telemetry,
  Telemetry.make({
    capture: () => Effect.void,
    identify: () => Effect.void,
  }),
);
