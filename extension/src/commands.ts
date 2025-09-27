import * as vscode from "vscode";
import { AssertionError } from "./assert.ts";
import { Logger } from "./logging.ts";

export function registerCommand(command: string, callback: () => unknown) {
  return vscode.commands.registerCommand(command, () => {
    Logger.info("Command.Execute", `Running command: ${command}`);
    return Promise.resolve(callback()).catch((error: unknown) => {
      let message: string;
      if (error instanceof AssertionError) {
        message = error.message;
      } else {
        message = `Unknown error: ${JSON.stringify(error)}`;
      }
      Logger.error("Command.Execute", `Command failed: ${command}`, error);
      vscode.window.showWarningMessage(message);
    });
  });
}
