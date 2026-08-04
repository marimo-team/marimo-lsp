import { Effect, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { SETUP_CELL_NAME } from "../constants.ts";
import { Constants } from "../platform/Constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import type { NotebookTarget } from "./Invocation.ts";
import { MarimoCommands } from "./MarimoCommands.ts";

const handler = Effect.fn("command.createSetupCell")(function* (
  target: Option.Option<NotebookTarget>,
) {
  const code = yield* VsCode;
  const { LanguageId } = yield* Constants;
  if (Option.isNone(target)) {
    yield* code.window.showInformationMessage(
      "No marimo notebook is currently open",
    );
    return;
  }

  // Check if setup cell already exists
  const notebook = target.value.document;
  const cells = notebook.getCells();
  const existing = cells.find((cell) => {
    return Option.isSome(cell.name) && cell.name.value === SETUP_CELL_NAME;
  });

  if (existing) {
    // Show message and focus on existing setup cell
    yield* code.window.showInformationMessage("Setup cell already exists");
    yield* code.window.showNotebookDocument(notebook.rawNotebookDocument, {
      selections: [new code.NotebookRange(existing.index, existing.index + 1)],
    });
    return;
  }

  {
    // Create new setup cell at index 0
    const edit = new code.WorkspaceEdit();
    const cell = new code.NotebookCellData(
      code.NotebookCellKind.Code,
      "# Initialization code that runs before all other cells",
      LanguageId.Python,
    );
    cell.metadata = MarimoNotebookCell.createMetadata({
      marimo: { name: SETUP_CELL_NAME },
      // marimo reserves the cell id "setup" for the setup cell: file
      // deserialization assigns it, and the kernel keys its setup-cell
      // semantics (auto-run-as-root when stale) on that exact id. A random
      // UUID here would leave the cell an ordinary cell until reopen.
      marimoRuntime: { stableId: SETUP_CELL_NAME },
    });
    edit.set(notebook.uri, [code.NotebookEdit.insertCells(0, [cell])]);
    yield* code.workspace.applyEdit(edit);
  }

  yield* Effect.logInfo("Created setup cell").pipe(
    Effect.annotateLogs({
      notebook: notebook.id,
    }),
  );
});

export default defineCommand(MarimoCommands.createSetupCell, handler);
