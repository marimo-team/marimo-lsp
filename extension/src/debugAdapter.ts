import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";
import type { BaseLanguageClient } from "vscode-languageclient";
import { executeCommand } from "./commands.ts";
import { Logger } from "./logging.ts";
import { notebookType } from "./types.ts";

export function debugAdapter(
  client: BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  Logger.info("Debug.Init", "Registering debug adapter");

  const disposeFactory = vscode.debug.registerDebugAdapterDescriptorFactory(
    "marimo",
    {
      createDebugAdapterDescriptor: createDebugAdapterDescriptor.bind(
        null,
        client,
      ),
    },
  );

  const disposeProvider = vscode.debug.registerDebugConfigurationProvider(
    "marimo",
    {
      resolveDebugConfiguration(_folder, config) {
        Logger.info("Debug.Config", "Resolving debug configuration", {
          config,
        });

        const notebook = vscode.window.activeNotebookEditor?.notebook;
        if (!notebook || notebook.notebookType !== notebookType) {
          Logger.warn("Debug.Config", "No active marimo notebook found");
          return undefined;
        }
        config.type = "marimo";
        config.name = config.name ?? "Debug Marimo";
        config.request = config.request ?? "launch";
        config.notebookUri = notebook.uri.toString();

        Logger.info("Debug.Config", "Configuration resolved", {
          notebookUri: config.notebookUri,
          type: config.type,
          request: config.request,
        });
        return config;
      },
    },
  );

  options.signal.addEventListener("abort", () => {
    Logger.info("Debug.Cleanup", "Disposing debug adapter");
    disposeFactory.dispose();
    disposeProvider.dispose();
  });
}

function createDebugAdapterDescriptor(
  client: lsp.BaseLanguageClient,
  session: vscode.DebugSession,
): vscode.DebugAdapterDescriptor {
  Logger.info("Debug.Factory", "Creating debug adapter", {
    sessionId: session.id,
    name: session.name,
    type: session.type,
    configuration: session.configuration,
  });

  const sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
  const disposer = client.onNotification(
    "marimo/dap",
    ({ sessionId, message }) => {
      Logger.debug("Debug.Receive", "Received DAP response from LSP", {
        sessionId,
        message,
      });
      if (sessionId === session.id) {
        sendMessage.fire(message);
      }
    },
  );

  return new vscode.DebugAdapterInlineImplementation({
    onDidSendMessage: sendMessage.event,
    handleMessage(message) {
      Logger.debug("Debug.Send", "Sending DAP message to LSP", {
        sessionId: session.id,
        message,
      });
      executeCommand(client, {
        command: "marimo.dap",
        params: {
          sessionId: session.id,
          notebookUri: session.configuration.notebookUri,
          message,
        },
      });
    },
    dispose() {
      disposer.dispose();
    },
  });
}
