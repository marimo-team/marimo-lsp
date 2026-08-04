import { Effect, flow, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { DebugAdapter } from "../kernel/DebugAdapter.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.debugCell")(
  function* (cell: Option.Option<MarimoNotebookCell>) {
    const code = yield* VsCode;
    const debugAdapter = yield* DebugAdapter;

    if (Option.isNone(cell)) {
      yield* code.window.showWarningMessage("No cell at the selected index.");
      return;
    }

    yield* debugAdapter.debugCell(cell.value);
  },
  flow(
    Effect.tapErrorCause(Effect.logError),
    Effect.catchTags({
      DebugSessionStartError: () =>
        showErrorAndPromptLogs(
          "Failed to start debug session. Is the kernel running?",
        ),
    }),
    Effect.catchAllCause(() => showErrorAndPromptLogs("Failed to debug cell.")),
  ),
);

export default defineCommand(MarimoCommands.debugCell, handler);
