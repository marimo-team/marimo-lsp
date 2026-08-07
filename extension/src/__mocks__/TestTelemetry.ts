import { Effect, Layer, Logger } from "effect";

import { Telemetry } from "../telemetry/Telemetry.ts";

/**
 * Test implementation of Telemetry that does nothing
 */
export const TestTelemetryLive = Layer.succeed(
  Telemetry,
  Telemetry.make({
    commandExecuted: () => Effect.void,
    notebookCreated: () => Effect.void,
    notebookOpened: () => Effect.void,
    tutorialOpened: () => Effect.void,
    uvMissing: () => Effect.void,
    uvInstallClicked: () => Effect.void,
    binaryResolved: () => Effect.void,
    lspModeSelected: () => Effect.void,
    lspStarted: () => Effect.void,
    errorLogger: Logger.none,
  }),
);
