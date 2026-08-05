import { Effect, Option } from "effect";
import type * as vscode from "vscode";

import { updateMarimoCellMetadata } from "../notebook/updateMarimoCellMetadata.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";

const MARKUP_CELL_KIND: vscode.NotebookCellKind = 1;

/** Persist and immediately apply the visibility requested by a cell menu item. */
const setCellCodeVisibility = Effect.fn("command.setCellCodeVisibility")(
  function* (cell: MarimoNotebookCell, hidden: boolean) {
    const code = yield* VsCode;

    const index = yield* updateMarimoCellMetadata(cell, (metadata) => ({
      ...metadata,
      options: { ...metadata.options, hide_code: hidden },
    }));

    // `hide_code` remains persisted marimo state for native markup cells, but
    // their VS Code input must stay expanded. Code cells mirror the persisted
    // value into the editor view.
    const command =
      cell.kind === MARKUP_CELL_KIND
        ? "notebook.cell.expandCellInput"
        : hidden
          ? "notebook.cell.collapseCellInput"
          : "notebook.cell.expandCellInput";

    yield* code.commands.executeVSCode(command, {
      ranges: [{ start: index, end: index + 1 }],
      document: cell.notebook.uri,
    });
  },
);

export const hideCellCode = (cell: Option.Option<MarimoNotebookCell>) =>
  Option.match(cell, {
    onNone: () => Effect.void,
    onSome: (value) => setCellCodeVisibility(value, true),
  });

export const showCellCode = (cell: Option.Option<MarimoNotebookCell>) =>
  Option.match(cell, {
    onNone: () => Effect.void,
    onSome: (value) => setCellCodeVisibility(value, false),
  });
