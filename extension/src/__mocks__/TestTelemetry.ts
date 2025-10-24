import { Effect, Layer } from "effect";
import { Telemetry } from "../services/Telemetry.ts";

/**
 * Test implementation of Telemetry that does nothing
 */
export const TestTelemetry = Layer.succeed(Telemetry, {
  _tag: "Telemetry",
  capture: () => Effect.void,
  identify: () => Effect.void,
});
