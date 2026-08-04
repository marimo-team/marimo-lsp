import { defineCommand } from "../commands.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { showCellCode } from "./setCellCodeVisibility.ts";

export default defineCommand(MarimoCommands.showCellCode, showCellCode);
