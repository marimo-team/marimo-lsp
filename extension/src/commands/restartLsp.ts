import { Effect } from "effect";

import { defineCommand } from "../commands.ts";
import { MarimoClient } from "../lsp/MarimoClient.ts";
import { LiveSessions } from "../panel/sessions/LiveSessions.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn(function* () {
  const marimo = yield* MarimoClient;
  const sessions = yield* LiveSessions;
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
