import { Effect, Option } from "effect";

import { SETUP_CELL_NAME } from "../constants.ts";
import { encodeCellMetadata, MarimoNotebookDocument } from "../schemas.ts";
import { VsCode } from "../services/VsCode.ts";

export const createSetupCell = Effect.fn(function* () {
  const code = yield* VsCode;
  const notebook = Option.filterMap(
    yield* code.window.getActiveNotebookEditor(),
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
      "python",
    );
    cell.metadata = encodeCellMetadata({ name: SETUP_CELL_NAME });
    edit.set(notebook.value.uri, [code.NotebookEdit.insertCells(0, [cell])]);
    yield* code.workspace.applyEdit(edit);
  }

  yield* Effect.logInfo("Created setup cell").pipe(
    Effect.annotateLogs({
      notebook: notebook.value.uri.toString(),
    }),
  );
});
