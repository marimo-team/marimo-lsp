import * as vscode from "vscode";
import { Logger } from "./logging.ts";
import { assert } from "./assert.ts";

/**
 * Types for marimo operations
 */
export interface MarimoOperation {
  notebookUri: string;
  op: string;
  data: any;
}

export interface OperationContext {
  notebookUri: string;
  controller: vscode.NotebookController;
  executions: Map<string, vscode.NotebookCellExecution>;
}

interface CellOp {
  cell_id: string;
  output?: CellOutput;
  console?: CellOutput | CellOutput[];
  status?: "queued" | "running" | "idle";
  stale_inputs?: boolean;
  run_id?: string;
  serialization?: string;
  timestamp: number;
}

interface CellOutput {
  channel: "output" | "console" | "stderr";
  mimetype: string;
  data: string;
  timestamp: number;
}

interface VariableValues {
  variables: Array<{
    name: string;
    type: string;
    value: string;
  }>;
}

export async function route(
  context: OperationContext,
  operation: MarimoOperation,
): Promise<void> {
  Logger.trace("OperationRouter", `Routing ${operation.op}`);

  switch (operation.op) {
    case "cell-op":
      await handleCellOp(context, operation.data as CellOp);
      break;

    case "variables":
      await handleVariables(context, operation.data as VariableValues);
      break;

    default:
      Logger.debug(
        "OperationRouter",
        `Unknown operation: ${operation.op}`,
        operation.data,
      );
  }
}

async function handleCellOp(
  context: OperationContext,
  cellOp: CellOp,
): Promise<void> {
  const { cell_id, status, output, console, timestamp } = cellOp;
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
  output: CellOutput,
): void {
  Logger.trace("CellOp", `Appending ${output.channel} output`);
  execution.appendOutput(
    new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.text(
        output.data,
        output.mimetype,
      ),
    ]),
  );
}

async function handleVariables(
  context: OperationContext,
  data: VariableValues,
): Promise<void> {
  Logger.debug("Variables", `Received ${data.variables.length} variables`);
  // TODO: Implement variable view update
  Logger.trace("Variables", "Variables:", data.variables);
}
