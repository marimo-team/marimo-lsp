import { Data, Effect } from "effect";
import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";
import { AssertionError } from "./assert.ts";
import { Logger } from "./logging.ts";
import type { MarimoCommand } from "./types.ts";

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

export function executeCommand(
  client: lsp.BaseLanguageClient,
  options: MarimoCommand & {
    token?: vscode.CancellationToken;
  },
): Promise<unknown> {
  const startTime = Date.now();
  Logger.debug("Command.LSP", `Executing LSP command: ${options.command}`);
  Logger.trace(
    "Command.LSP",
    `Parameters for ${options.command}`,
    options.params,
  );

  return client
    .sendRequest<unknown>(
      "workspace/executeCommand",
      {
        command: options.command,
        arguments: [options.params],
      },
      options.token,
    )
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

class ExecuteCommandError extends Data.TaggedError("ExecuteCommandError")<{
  readonly command: MarimoCommand;
  readonly error: unknown;
}> {}

export function executeCommandEffect(
  client: lsp.BaseLanguageClient,
  command: MarimoCommand,
) {
  return Effect.tryPromise({
    try: () => executeCommand(client, command),
    catch: (error) => new ExecuteCommandError({ command, error }),
  });
}
