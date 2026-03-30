import { Effect } from "effect";

import { LanguageClient } from "../lsp/LanguageClient.ts";

export const restartLsp = Effect.fn(function* () {
  const client = yield* LanguageClient;
  yield* client.restart();
});
