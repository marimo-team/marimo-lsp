import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";
import { executeCommand } from "./commands.ts";
import { Logger } from "./logging.ts";
import { registerNotificationHandler } from "./notifications.ts";
import { notebookType } from "./types.ts";

export function debugAdapter(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  Logger.info("Debug.Init", "Registering debug adapter");

  const disposeFactory = vscode.debug.registerDebugAdapterDescriptorFactory(
    "marimo",
    {
      createDebugAdapterDescriptor: createDebugAdapterDescriptor.bind(null, {
        client,
        signal: options.signal,
      }),
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
  ctx: {
    client: lsp.BaseLanguageClient;
    signal: AbortSignal;
  },
  session: vscode.DebugSession,
): vscode.DebugAdapterDescriptor {
  Logger.info("Debug.Factory", "Creating debug adapter", {
    sessionId: session.id,
    name: session.name,
    type: session.type,
    configuration: session.configuration,
  });

  const sendMessage = new vscode.EventEmitter<vscode.DebugProtocolMessage>();

  registerNotificationHandler(ctx.client, {
    method: "marimo/dap",
    callback: ({ sessionId, message }) => {
      Logger.debug("Debug.Receive", "Received DAP response from LSP", {
        sessionId,
        message,
      });
      if (sessionId === session.id) {
        sendMessage.fire(message);
      }
    },
    signal: ctx.signal,
  });

  return new vscode.DebugAdapterInlineImplementation({
    onDidSendMessage: sendMessage.event,
    handleMessage(message) {
      Logger.debug("Debug.Send", "Sending DAP message to LSP", {
        sessionId: session.id,
        message,
      });
      executeCommand(ctx.client, {
        command: "marimo.dap",
        params: {
          notebookUri: session.configuration.notebookUri,
          inner: {
            sessionId: session.id,
            message,
          },
        },
      });
    },
    dispose() {},
  });
}
