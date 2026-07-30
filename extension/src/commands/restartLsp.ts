import { Effect } from "effect";

import { MarimoClient } from "../lsp/MarimoClient.ts";

export const restartLsp = Effect.fn(function* () {
  const marimo = yield* MarimoClient;
  yield* marimo.restart();
});
