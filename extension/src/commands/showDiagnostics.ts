import { Effect } from "effect";

import { defineCommand } from "../commands.ts";
import * as HealthService from "../telemetry/HealthService.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.showDiagnostics")(function* () {
  const healthService = yield* HealthService.Service;
  yield* healthService.showDiagnostics;
});

export default defineCommand(MarimoCommands.showDiagnostics, handler);
