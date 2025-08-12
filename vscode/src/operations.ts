import * as vscode from "vscode";
import type * as mo from "@marimo-team/marimo-api/src/api";

import { Logger } from "./logging.ts";
import { assert } from "./assert.ts";

type OperationMessageType =
  mo.components["schemas"]["MessageOperation"]["name"];
type OperationMessageData<T extends OperationMessageType> = Omit<
  Extract<mo.components["schemas"]["MessageOperation"], { name: T }>,
  "name"
>;
export type OperationMessage = {
  [Type in OperationMessageType]: {
    op: Type;
    data: Omit<
      Extract<mo.components["schemas"]["MessageOperation"], { name: Type }>,
      "name"
    >;
  };
}[OperationMessageType];

export interface OperationContext {
  notebookUri: string;
  controller: vscode.NotebookController;
  executions: Map<string, vscode.NotebookCellExecution>;
}

export async function route(
  context: OperationContext,
  operation: OperationMessage,
): Promise<void> {
  Logger.trace("Operation.Router", `Received: ${operation.op}`, operation.data);
  switch (operation.op) {
    case "cell-op":
      Logger.debug(
        "Cell.Operation",
        `Processing: ${operation.data.status}`,
        { cellId: operation.data.cell_id, status: operation.data.status },
      );
      await handleCellOperation(context, operation.data);
      break;

    default:
      Logger.warn(
        "Operation.Router",
        `Unknown operation: ${operation.op}`,
        operation,
      );
  }
}

async function handleCellOperation(
  context: OperationContext,
  data: OperationMessageData<"cell-op">,
): Promise<void> {
  const { cell_id, status, output, console, timestamp } = data;
  const cell = getNotebookCell(context.notebookUri, cell_id);

  switch (status) {
    case "queued": {
      Logger.debug("Cell.State", `Queued: ${cell_id}`);
      const execution = context.controller.createNotebookCellExecution(cell);
      context.executions.set(cell_id, execution);
      break;
    }

    case "running": {
      const execution = context.executions.get(cell_id);
      if (execution) {
        Logger.debug("Cell.State", `Running: ${cell_id}`);
        execution.start(timestamp);
        execution.clearOutput();
      } else {
        Logger.warn("Cell.State", `No execution found for running cell: ${cell_id}`);
      }
      break;
    }

    case "idle": {
      const execution = context.executions.get(cell_id);
      if (execution) {
        Logger.debug("Cell.State", `Completed: ${cell_id}`);
        execution.end(true, timestamp);
        context.executions.delete(cell_id);
      } else {
        Logger.warn("Cell.State", `No execution found for idle cell: ${cell_id}`);
      }
      break;
    }
  }

  const execution = context.executions.get(cell_id);
  if (execution) {
    if (output) {
      appendOutput(execution, output);
    }

    if (console) {
      const consoleOutputs = Array.isArray(console) ? console : [console];
      for (const consoleOutput of consoleOutputs) {
        appendOutput(execution, consoleOutput);
      }
    }
  }
}

function appendOutput(
  execution: vscode.NotebookCellExecution,
  output: OperationMessageData<"cell-op">["output"],
): void {
  if (!output?.channel || !(typeof output?.data === "string")) {
    return;
  }
  Logger.trace("Cell.Output", `Appending ${output.channel} output`);

  if (output.mimetype === "text/html") {
    execution.appendOutput(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          output.data,
          "application/vnd.marimo.ui+json",
        ),
      ]),
    );
  } else {
    execution.appendOutput(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.text(
          output.data,
          output.mimetype,
        ),
      ]),
    );
  }
}

function getNotebookDocument(notebookUri: string): vscode.NotebookDocument {
  const notebook = vscode.workspace.notebookDocuments.find(
    (nb) => nb.uri.toString() === notebookUri,
  );
  assert(notebook, `No notebook ${notebookUri} in workspace.`);
  return notebook;
}

function getNotebookCell(
  notebookUri: string,
  cellId: string,
): vscode.NotebookCell {
  const notebook = getNotebookDocument(notebookUri);
  const cell = notebook.getCells().find((c) =>
    c.document.uri.toString() === cellId
  );
  assert(cell, `No cell id ${cellId} in notebook ${notebookUri} `);
  return cell;
}
