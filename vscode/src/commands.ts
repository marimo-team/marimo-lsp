import * as lsp from "vscode-languageclient";
import * as vscode from "vscode";
import type { components as Api } from "@marimo-team/openapi";

import { AssertionError } from "./assert.ts";
import { NotebookSerialization } from "./schemas.ts";
import { Logger } from "./logging.ts";

export function registerCommand(
  command: string,
  callback: () => unknown,
) {
  return vscode.commands.registerCommand(command, () => {
    Logger.info("Command.Execute", `Running command: ${command}`);
    return Promise
      .resolve(callback())
      .catch((error: unknown) => {
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

type WithNotebookUri<T> = T & { notebookUri: string };

export type RequestMap = {
  "marimo.run": WithNotebookUri<Api["schemas"]["RunRequest"]>;
  "marmo.kernel.set_ui_element_value": WithNotebookUri<Api["schemas"]["SetUIElementValueRequest"]>;
  "marimo.serialize": { notebook: NotebookSerialization };
  "marimo.deserialize": { source: string };
};

export function executeCommand<K extends keyof RequestMap>(
  client: lsp.BaseLanguageClient,
  options: {
    command: K;
    params: RequestMap[K];
    token?: vscode.CancellationToken;
  },
): Promise<unknown> {
  const startTime = Date.now();
  Logger.debug("Command.LSP", `Executing LSP command: ${options.command}`);
  Logger.trace("Command.LSP", `Parameters for ${options.command}`, options.params);
  
  return client.sendRequest<unknown>("workspace/executeCommand", {
    command: options.command,
    arguments: [options.params],
  }, options.token)
    .then((result) => {
      Logger.debug("Command.LSP", `Command completed: ${options.command}`, {
        duration: Date.now() - startTime,
      });
      Logger.trace("Command.LSP", `Result for ${options.command}`, result);
      return result;
    })
    .catch((error) => {
      Logger.error("Command.LSP", `Command failed: ${options.command}`, {
        duration: Date.now() - startTime,
        error,
      });
      throw error;
    });
}
