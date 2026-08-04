import { defineCommand } from "../commands.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { openSession } from "./sessionCommands.ts";

export default defineCommand(MarimoCommands.openSession, openSession);
