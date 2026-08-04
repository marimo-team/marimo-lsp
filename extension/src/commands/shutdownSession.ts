import { defineCommand } from "../commands.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { shutdownSession } from "./sessionCommands.ts";

export default defineCommand(MarimoCommands.shutdownSession, shutdownSession);
