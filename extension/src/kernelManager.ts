import * as vscode from "vscode";
import type * as lsp from "vscode-languageclient";
import { assert } from "./assert.ts";
import * as cmds from "./commands.ts";
import { Logger } from "./logging.ts";
import { registerNotificationHandler } from "./notifications.ts";
import * as ops from "./operations.ts";
import { notebookType, type RendererCommand } from "./types.ts";

export function kernelManager(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  const channel = vscode.notebooks.createRendererMessaging("marimo-renderer");
  const controller = vscode.notebooks.createNotebookController(
    "marimo-controller",
    notebookType,
    "marimo kernel",
    async (
      cells: vscode.NotebookCell[],
      notebookDocument: vscode.NotebookDocument,
    ) => {
      Logger.info("Kernel.Execute", "Running cells", {
        cellCount: cells.length,
        notebook: notebookDocument.uri.toString(),
      });
      Logger.trace("Kernel.Execute", "Cell URIs", {
        cells: cells.map((c) => c.document.uri.toString()),
      });
      await cmds.executeCommand(client, {
        command: "marimo.run",
        params: {
          notebookUri: notebookDocument.uri.toString(),
          inner: {
            cellIds: cells.map((cell) => cell.document.uri.toString()),
            codes: cells.map((cell) => cell.document.getText()),
          },
        },
      });
    },
  );

  channel.onDidReceiveMessage(
    async (data: {
      editor: vscode.NotebookEditor;
      message: RendererCommand;
    }) => {
      const { editor, message } = data;
      assert("command" in message && "params" in message, "unknown message");
      // route renderer command with notebook_uri
      await cmds.executeCommand(client, {
        command: message.command,
        params: {
          notebookUri: editor.notebook.uri.toString(),
          inner: message.params,
        },
      });
    },
  );

  const contexts = new Map<string, ops.OperationContext>();

  registerNotificationHandler(client, {
    method: "marimo/operation",
    callback: async (message) => {
      const { notebookUri, operation } = message;
      let context = contexts.get(notebookUri);
      if (!context) {
        context = { notebookUri, controller, executions: new Map() };
        contexts.set(notebookUri, context);
      }
      await ops.route(context, operation);
    },
    signal: options.signal,
  });

  options.signal.addEventListener("abort", () => {
    controller.dispose();
    contexts.clear();
    Logger.info("Kernel.Lifecycle", "Kernel manager disposed");
  });

  Logger.info("Kernel.Lifecycle", "Kernel manager initialized");
}
