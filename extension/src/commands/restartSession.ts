import { defineCommand } from "../commands.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { restartSession } from "./sessionCommands.ts";

export default defineCommand(MarimoCommands.restartSession, restartSession);
