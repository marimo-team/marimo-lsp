import { Effect, flow, Option } from "effect";

import { defineCommand } from "../commands.ts";
import * as DebugAdapter from "../kernel/DebugAdapter.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import * as VsCode from "../platform/VsCode.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.debugCell")(
  function* (cell: Option.Option<MarimoNotebookCell>) {
    const code = yield* VsCode.Service;
    const debugAdapter = yield* DebugAdapter.Service;

    if (Option.isNone(cell)) {
      yield* code.window.showWarningMessage("No cell at the selected index.");
      return;
    }

    yield* debugAdapter.debugCell(cell.value);
  },
  flow(
    Effect.tapCause(Effect.logError),
    Effect.catchTags({
      "Debug.SessionStartError": () =>
        showErrorAndPromptLogs(
          "Failed to start debug session. Is the kernel running?",
        ),
    }),
    Effect.catchCause(() => showErrorAndPromptLogs("Failed to debug cell.")),
  ),
);

export default defineCommand(MarimoCommands.debugCell, handler);
