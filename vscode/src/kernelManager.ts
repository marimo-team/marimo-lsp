import * as vscode from "vscode";
import * as lsp from "vscode-languageclient";

import { Logger } from "./logging.ts";
import { MarimoNotebookSerializer } from "./notebookSerializer.ts";
import { executeCommand } from "./commands.ts";
import { assert } from "./assert.ts";

/**
 * Marimo Notebook Controller
 *
 * Provides kernel execution capabilities for marimo notebooks
 */
export class KernelManager implements vscode.Disposable {
  public readonly controller: vscode.NotebookController;
  private executions: Map<string, Map<string, vscode.NotebookCellExecution>> =
    new Map();

  constructor(client: lsp.BaseLanguageClient) {
    this.controller = vscode.notebooks.createNotebookController(
      "marimo-lsp-controller",
      MarimoNotebookSerializer.notebookType,
      "marimo kernel",
      async (cells, notebookDocument) => {
        Logger.debug("KernelManager", "executeHandler");
        Logger.trace("KernelManager", "executeHandler", {
          cells,
          notebookDocument,
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

    client.onNotification("marimo/operation", (operation) => {
      const { notebookUri, op, data } = operation;
      const executions = this.executions.get(notebookUri) ??
        new Map<string, vscode.NotebookCellExecution>();
      this.executions.set(notebookUri, executions);

      if (op === "cell-op") {
        type CellOp = {
          cell_id: string;
          status: "queued" | "running" | "idle" | null;
          timestamp: number;
          output: null | {
            channel: string;
            mimetype: string;
            data: string;
            timestamp: number;
          };
        };
        const cellOp: CellOp = data;
        const cellId = cellOp.cell_id;

        const notebook = vscode.workspace.notebookDocuments.find(
          (notebook) => notebook.uri.toString() === notebookUri,
        );
        assert(notebook, `No notebook ${notebookUri} in workspace.`);

        const cell = notebook.getCells().find((cell) =>
          cell.document.uri.toString() === cellId
        );
        assert(cell, `No cell id ${cellId} in notebook ${notebookUri}`);

        if (cellOp.status === "queued") {
          // create the new cell execution
          Logger.error("cell-op", "Queued", cellId);
          const execution = this.controller.createNotebookCellExecution(cell);
          executions.set(cellId, execution);
          return;
        }

        let execution = executions.get(cellOp.cell_id);

        if (cellOp.status === "running") {
          Logger.error("cell-op", "Running", cellId);
          assert(execution);
          execution.start(cellOp.timestamp);
          execution.clearOutput();
          return;
        }

        if (cellOp.output) {
          Logger.error("cell-op", "Output", cellId);
          assert(execution);
          execution.appendOutput(
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(
                cellOp.output.data,
                cellOp.output.mimetype,
              ),
            ]),
          );
        }

        if (cellOp.status === "idle") {
          Logger.error("cell-op", "Idle", cellId);
          assert(execution);
          execution.end(true, cellOp.timestamp);
        }
      }
    });
  }

  public dispose() {
    this.controller.dispose();
  }
}
