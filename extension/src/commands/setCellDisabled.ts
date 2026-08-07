import { Effect, Option } from "effect";

import { SETUP_CELL_NAME } from "../constants.ts";
import { updateMarimoCellMetadata } from "../notebook/updateMarimoCellMetadata.ts";
import type { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";

export const setCellDisabled = Effect.fn("command.setCellDisabled")(function* (
  cell: Option.Option<MarimoNotebookCell>,
  disabled: boolean,
) {
  if (Option.isNone(cell) || cell.value.isDisabled === disabled) return;
  const isSetupCell =
    Option.contains(cell.value.name, SETUP_CELL_NAME) ||
    Option.contains(cell.value.stableId, SETUP_CELL_NAME);
  if (disabled && isSetupCell) return;

  yield* updateMarimoCellMetadata(cell.value, (metadata) => ({
    ...metadata,
    options: { ...metadata.options, disabled },
  }));
});
