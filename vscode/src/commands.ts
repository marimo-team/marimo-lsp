import * as lsp from "vscode-languageclient";
import * as vscode from "vscode";

import { AssertionError } from "./assert.ts";
import { NotebookSerialization } from "./schemas.ts";

export function registerCommand(
  command: string,
  callback: () => unknown,
) {
  return vscode.commands.registerCommand(command, () =>
    Promise
      .resolve(callback())
      .catch((error: unknown) => {
        let message: string;
        if (error instanceof AssertionError) {
          message = error.message;
        } else {
          message = `Unknown error: ${JSON.stringify(error)}`;
        }
        vscode.window.showWarningMessage(message);
      }));
}

type WithNotebookUri<T> = T & { notebookUri: string };

// TODO: Get from "@marimo-team/marimo-api/src/api.ts";
type RunRequest = {
  cellIds: string[];
  codes: string[];
};

type RequestMap = {
  "marimo.run": WithNotebookUri<RunRequest>;
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
  return client.sendRequest<unknown>("workspace/executeCommand", {
    command: options.command,
    arguments: [options.params],
  }, options.token);
}
