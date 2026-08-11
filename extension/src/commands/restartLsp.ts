import { Effect } from "effect";

import { defineCommand } from "../commands.ts";
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { SessionsService } from "../panel/sessions/SessionsService.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn(function* () {
  const marimo = yield* MarimoClient;
  const sessions = yield* SessionsService;
  yield* marimo.restart;
  yield* sessions
    .refresh()
    .pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to refresh sessions after LSP restart").pipe(
          Effect.annotateLogs({ cause }),
        ),
      ),
    );
});

export default defineCommand(MarimoCommands.restartLsp, handler);
