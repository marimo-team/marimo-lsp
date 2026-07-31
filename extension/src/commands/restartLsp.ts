import { Effect } from "effect";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import { SessionsService } from "../panel/sessions/SessionsService.ts";

export const restartLsp = Effect.fn(function* () {
  const marimo = yield* MarimoClient;
  const sessions = yield* SessionsService;
  yield* marimo.restart();
  yield* sessions.refresh();
});
