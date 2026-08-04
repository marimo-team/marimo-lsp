import { Effect } from "effect";

import { defineMarimoCommand } from "../commands.ts";
import { CellMetadataUIBindingService } from "../notebook/CellMetadataUIBindingService.ts";
import { updateCellMetadataContract } from "./updateCellMetadataCommand.ts";

export const updateCellMetadataCommand = defineMarimoCommand(
  updateCellMetadataContract,
  Effect.fn("command.updateCellMetadata")(function* (bindingId) {
    const bindings = yield* CellMetadataUIBindingService;
    yield* bindings.updateBinding(bindingId);
  }),
);
