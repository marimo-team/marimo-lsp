import { Effect, flow, Option } from "effect";

import { MarimoNotebookDocument } from "../notebook/schemas/vscode-notebook.ts";
import { DebugAdapter } from "../kernel/DebugAdapter.ts";
import { VsCode } from "../platform/VsCode.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";

export const debugCell = Effect.fn("command.debugCell")(
  function* () {
    const code = yield* VsCode;
    const debugAdapter = yield* DebugAdapter;

    const editor = yield* code.window.getActiveNotebookEditor();
    if (Option.isNone(editor)) {
      yield* code.window.showWarningMessage("No active notebook editor.");
      return;
    }

    const notebook = MarimoNotebookDocument.tryFrom(editor.value.notebook);
    if (Option.isNone(notebook)) {
      yield* code.window.showWarningMessage(
        "Active notebook is not a marimo notebook.",
      );
      return;
    }

    const selection = editor.value.selections[0];
    if (!selection) {
      yield* code.window.showWarningMessage("No cell selected.");
      return;
    }

    const cell = notebook.value.getCells()[selection.start];
    if (!cell) {
      yield* code.window.showWarningMessage("No cell at the selected index.");
      return;
    }

    yield* debugAdapter.debugCell(cell);
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
