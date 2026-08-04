import { Effect } from "effect";

import { defineCommand } from "../commands.ts";
import { HealthService } from "../telemetry/HealthService.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.showDiagnostics")(function* () {
  const healthService = yield* HealthService;
  yield* healthService.showDiagnostics();
});

export default defineCommand(MarimoCommands.showDiagnostics, handler);
