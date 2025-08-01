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
  Logger.trace("OperationRouter", `${operation.op}`, operation.data);

  switch (operation.op) {
    case "cell-op":
      await handleCellOperation(context, operation.data);
      break;

    default:
      Logger.debug(
        "OperationRouter",
        `Unknown operation: ${operation.op}`,
        operation.data,
      );
  }
}

async function handleCellOperation(
  context: OperationContext,
  data: OperationMessageData<"cell-op">,
): Promise<void> {
  const { cell_id, status, output, console, timestamp } = data;
  Logger.debug("CellOp", `Processing ${status} for cell ${cell_id}`);

  const notebook = vscode.workspace.notebookDocuments.find(
    (nb) => nb.uri.toString() === context.notebookUri,
  );
  assert(notebook, `No notebook ${context.notebookUri} in workspace.`);

  const cell = notebook.getCells().find(
    (c) => c.document.uri.toString() === cell_id,
  );
  assert(
    cell,
    `No cell id ${cell_id} in notebook ${context.notebookUri} `,
  );

  switch (status) {
    case "queued": {
      Logger.debug("CellOp", `Cell ${cell_id} queued`);
      const execution = context.controller.createNotebookCellExecution(
        cell,
      );
      context.executions.set(cell_id, execution);
      break;
    }

    case "running": {
      const execution = context.executions.get(cell_id);
      if (execution) {
        Logger.debug("CellOp", "Cell running");
        execution.start(timestamp);
        execution.clearOutput();
      } else {
        Logger.warn("CellOp", "No execution found for running cell");
      }
      break;
    }

    case "idle": {
      const execution = context.executions.get(cell_id);
      if (execution) {
        Logger.debug("CellOp", `Cell ${cell_id} idle`);
        execution.end(true, timestamp);
        context.executions.delete(cell_id);
      } else {
        Logger.warn("CellOp", "No execution found for idle cell");
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
  Logger.trace("CellOp", `Appending ${output.channel} output`);

  if (output.mimetype === "text/html") {
    execution.appendOutput(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(
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
