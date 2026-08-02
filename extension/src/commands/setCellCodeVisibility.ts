import { Effect } from "effect";
import type * as vscode from "vscode";

import { updateMarimoCellMetadata } from "../notebook/updateMarimoCellMetadata.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";

/** Persist and immediately apply the visibility requested by a cell menu item. */
export const setCellCodeVisibility = Effect.fn("command.setCellCodeVisibility")(
  function* (rawCell: vscode.NotebookCell, hidden: boolean) {
    const code = yield* VsCode;
    const cell = MarimoNotebookCell.from(rawCell);

    yield* updateMarimoCellMetadata(cell, (metadata) => ({
      ...metadata,
      options: { ...metadata.options, hide_code: hidden },
    }));

    // Apply the requested view state even when metadata already had this value,
    // such as after a user manually expanded a persisted hidden cell.
    yield* code.commands.executeVSCode(
      hidden
        ? "notebook.cell.collapseCellInput"
        : "notebook.cell.expandCellInput",
      {
        ranges: [{ start: cell.index, end: cell.index + 1 }],
        document: cell.notebook.uri,
      },
    );
  },
);
