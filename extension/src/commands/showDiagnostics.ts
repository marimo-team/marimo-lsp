import { Effect } from "effect";

import { HealthService } from "../services/HealthService.ts";

export const showDiagnostics = Effect.fn(function* () {
  const healthService = yield* HealthService;
  yield* healthService.showDiagnostics();
});
