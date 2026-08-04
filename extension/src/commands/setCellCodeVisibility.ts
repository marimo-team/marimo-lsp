import { Effect, Option } from "effect";

import { updateMarimoCellMetadata } from "../notebook/updateMarimoCellMetadata.ts";
import { VsCode } from "../platform/VsCode.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";

/** Persist and immediately apply the visibility requested by a cell menu item. */
const setCellCodeVisibility = Effect.fn("command.setCellCodeVisibility")(
  function* (cell: MarimoNotebookCell, hidden: boolean) {
    const code = yield* VsCode;

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
