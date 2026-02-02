import { Effect } from "effect";
import { LanguageClient } from "../services/LanguageClient.ts";

export const restartLsp = Effect.fn(function* () {
  const client = yield* LanguageClient;
  yield* client.restart();
});
