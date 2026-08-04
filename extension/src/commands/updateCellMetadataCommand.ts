import { Schema } from "effect";

import { withFirstArgument } from "../commands.ts";
import { GeneratedMarimoCommands } from "./MarimoCommands.gen.ts";

export const updateCellMetadataContract = withFirstArgument(
  GeneratedMarimoCommands.updateCellMetadata,
  Schema.String,
);
