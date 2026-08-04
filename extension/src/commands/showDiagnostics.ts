import { Effect } from "effect";

import { defineMarimoCommand } from "../commands.ts";
import { HealthService } from "../telemetry/HealthService.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

const showDiagnostics = Effect.fn("command.showDiagnostics")(function* () {
  const healthService = yield* HealthService;
  yield* healthService.showDiagnostics();
});

export const showDiagnosticsCommand = defineMarimoCommand(
  GeneratedMarimoCommands.showDiagnostics,
  showDiagnostics,
);
