import { defineCommand } from "../commands.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { setCellDisabled } from "./setCellDisabled.ts";

export default defineCommand(MarimoCommands.enableCell, (cell) =>
  setCellDisabled(cell, false),
);
