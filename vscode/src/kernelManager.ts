import * as vscode from "vscode";
import * as lsp from "vscode-languageclient";

import { Logger } from "./logging.ts";
import { MarimoNotebookSerializer } from "./notebookSerializer.ts";
import { executeCommand } from "./commands.ts";
import { MarimoOperation, OperationContext, route } from "./operations.ts";

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
      await executeCommand(client, {
        command: "marimo.run",
        params: {
          notebookUri: notebookDocument.uri.toString(),
          cellIds: cells.map((cell) => cell.document.uri.toString()),
          codes: cells.map((cell) => cell.document.getText()),
        },
      });
    },
  );

  const executionContexts = new Map<string, OperationContext>();
  const operationListener = client.onNotification(
    "marimo/operation",
    async (operation: MarimoOperation) => {
      Logger.trace("KernelManager", `Received operation: ${operation.op}`);

      let context = executionContexts.get(operation.notebookUri);
      if (!context) {
        context = {
          notebookUri: operation.notebookUri,
          controller: controller,
          executions: new Map(),
        };
        executionContexts.set(operation.notebookUri, context);
      }

      await route(context, operation);
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
