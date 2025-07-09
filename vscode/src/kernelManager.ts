import * as vscode from "vscode";
import * as lsp from "vscode-languageclient";

import { Logger } from "./logging.ts";
import { MarimoNotebookSerializer } from "./notebookSerializer.ts";
import * as cmds from "./commands.ts";
import * as ops from "./operations.ts";

export function kernelManager(
  client: lsp.BaseLanguageClient,
  options: { signal: AbortSignal },
) {
  const controller = vscode.notebooks.createNotebookController(
    "marimo-lsp-controller",
    MarimoNotebookSerializer.notebookType,
    "marimo kernel",
    async (
      cells: vscode.NotebookCell[],
      notebookDocument: vscode.NotebookDocument,
    ) => {
      Logger.debug("KernelManager", "executeHandler");
      Logger.trace("KernelManager", "executeHandler", {
        cells: cells.map((c) => c.document.uri.toString()),
        notebookDocument: notebookDocument.uri.toString(),
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

  const executionContexts = new Map<string, ops.OperationContext>();
  const operationListener = client.onNotification(
    "marimo/operation",
    async (
      { notebookUri, ...operation }:
        & { notebookUri: string }
        & ops.OperationMessage,
    ) => {
      Logger.trace("KernelManager", `Received operation: ${operation.op}`);

      let context = executionContexts.get(notebookUri);
      if (!context) {
        context = { notebookUri, controller, executions: new Map() };
        executionContexts.set(notebookUri, context);
      }

      await ops.route(context, operation);
    },
  );

  options.signal.addEventListener("abort", () => {
    controller.dispose();
    operationListener.dispose();
    executionContexts.clear();
    Logger.info("KernelManager", "Disposed");
  });

  Logger.info("KernelManager", "Initialized");
}
