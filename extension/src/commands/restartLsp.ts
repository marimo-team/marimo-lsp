import { Effect } from "effect";

import { defineMarimoCommand } from "../commands.ts";
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { SessionsService } from "../panel/sessions/SessionsService.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

const restartLsp = Effect.fn(function* () {
  const marimo = yield* MarimoClient;
  const sessions = yield* SessionsService;
  yield* marimo.restart();
  yield* sessions
    .refresh()
    .pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning("Failed to refresh sessions after LSP restart").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    );
});

export const restartLspCommand = defineMarimoCommand(
  GeneratedMarimoCommands.restartLsp,
  restartLsp,
);
