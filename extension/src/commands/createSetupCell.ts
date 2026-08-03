import { Effect, Option } from "effect";

import type { NotebookToolbarContext } from "../commands.ts";
import { SETUP_CELL_NAME } from "../constants.ts";
import { getNotebookCommandEditor } from "../lib/getNotebookCommandEditor.ts";
import { Constants } from "../platform/Constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";

export const createSetupCell = Effect.fn("command.createSetupCell")(function* (
  context?: NotebookToolbarContext,
) {
  const code = yield* VsCode;
  const { LanguageId } = yield* Constants;
  const notebook = Option.filterMap(
    yield* getNotebookCommandEditor(context),
    (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
  );

  if (Option.isNone(notebook)) {
    yield* code.window.showInformationMessage(
      "No marimo notebook is currently open",
    );
    return;
  }

  // Check if setup cell already exists
  const cells = notebook.value.getCells();
  const existing = cells.find((cell) => {
    return Option.isSome(cell.name) && cell.name.value === SETUP_CELL_NAME;
  });

  if (existing) {
    // Show message and focus on existing setup cell
    yield* code.window.showInformationMessage("Setup cell already exists");
    yield* code.window.showNotebookDocument(
      notebook.value.rawNotebookDocument,
      {
        selections: [
          new code.NotebookRange(existing.index, existing.index + 1),
        ],
      },
    );
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
    edit.set(notebook.value.uri, [code.NotebookEdit.insertCells(0, [cell])]);
    yield* code.workspace.applyEdit(edit);
  }

  yield* Effect.logInfo("Created setup cell").pipe(
    Effect.annotateLogs({
      notebook: notebook.value.id,
    }),
  );
});
