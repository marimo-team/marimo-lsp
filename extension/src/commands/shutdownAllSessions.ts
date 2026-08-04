import { defineCommand } from "../commands.ts";
import { MarimoCommands } from "./MarimoCommands.ts";
import { shutdownAllSessions } from "./sessionCommands.ts";

export default defineCommand(
  MarimoCommands.shutdownAllSessions,
  shutdownAllSessions,
);
