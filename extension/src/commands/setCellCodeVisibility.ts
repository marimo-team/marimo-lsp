import { Effect } from "effect";
import type * as vscode from "vscode";

import { defineMarimoCommand, withFirstArgument } from "../commands.ts";
import { updateMarimoCellMetadata } from "../notebook/updateMarimoCellMetadata.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";
import { VscodeNotebookCellSchema } from "./NotebookCommandTarget.ts";

/** Persist and immediately apply the visibility requested by a cell menu item. */
const setCellCodeVisibility = Effect.fn("command.setCellCodeVisibility")(
  function* (rawCell: vscode.NotebookCell, hidden: boolean) {
    const code = yield* VsCode;
    const cell = MarimoNotebookCell.from(rawCell);

    const index = yield* updateMarimoCellMetadata(cell, (metadata) => ({
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
        ranges: [{ start: index, end: index + 1 }],
        document: cell.notebook.uri,
      },
    );
  },
);

export const hideCellCodeCommand = defineMarimoCommand(
  withFirstArgument(
    GeneratedMarimoCommands.hideCellCode,
    VscodeNotebookCellSchema,
  ),
  (cell) => setCellCodeVisibility(cell, true),
);

export const showCellCodeCommand = defineMarimoCommand(
  withFirstArgument(
    GeneratedMarimoCommands.showCellCode,
    VscodeNotebookCellSchema,
  ),
  (cell) => setCellCodeVisibility(cell, false),
);
