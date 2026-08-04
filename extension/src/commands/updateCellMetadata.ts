import { Effect, Option } from "effect";

import { defineCommand } from "../commands.ts";
import { CellMetadataUIBindingService } from "../notebook/CellMetadataUIBindingService.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import {
  type CellMetadataBindingId,
  MarimoCommands,
} from "./MarimoCommands.ts";

const handler = Effect.fn("command.updateCellMetadata")(function* (
  cell: Option.Option<MarimoNotebookCell>,
  bindingId: CellMetadataBindingId,
) {
  const bindings = yield* CellMetadataUIBindingService;
  yield* bindings.updateBinding(cell, bindingId);
});

export default defineCommand(MarimoCommands.updateCellMetadata, handler);
