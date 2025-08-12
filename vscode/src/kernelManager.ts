import * as vscode from "vscode";
import * as lsp from "vscode-languageclient";

import { Logger } from "./logging.ts";
import { MarimoNotebookSerializer } from "./notebookSerializer.ts";
import * as cmds from "./commands.ts";
import * as ops from "./operations.ts";
import { assert } from "./assert.ts";

export function kernelManager(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  const channel = vscode.notebooks.createRendererMessaging("marimo-renderer");
  const controller = vscode.notebooks.createNotebookController(
    "marimo-lsp-controller",
    MarimoNotebookSerializer.notebookType,
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
          cellIds: cells.map((cell) => cell.document.uri.toString()),
          codes: cells.map((cell) => cell.document.getText()),
        },
      });
    },
  );

  channel.onDidReceiveMessage(async ({ editor, message }) => {
    assert("command" in message, "unknown message")
    await cmds.executeCommand(client, {
      command: message.command,
      params: {
        notebookUri: editor.notebook.uri.toString(),
        ...message.params,
      }
    })
  });

  const contexts = new Map<string, ops.OperationContext>();
  const operationListener = client.onNotification(
    "marimo/operation",
    async (message: { notebookUri: string } & ops.OperationMessage) => {
      const { notebookUri, ...operation } = message;
      let context = contexts.get(notebookUri);
      if (!context) {
        context = { notebookUri, controller, executions: new Map() };
        contexts.set(notebookUri, context);
      }
      await ops.route(context, operation);
    },
  );

  options.signal.addEventListener("abort", () => {
    controller.dispose();
    operationListener.dispose();
    contexts.clear();
    Logger.info("Kernel.Lifecycle", "Kernel manager disposed");
  });

  Logger.info("Kernel.Lifecycle", "Kernel manager initialized");
}
