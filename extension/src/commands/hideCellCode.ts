import { defineCommand } from "../commands.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { hideCellCode } from "./setCellCodeVisibility.ts";

export default defineCommand(MarimoCommands.hideCellCode, hideCellCode);
