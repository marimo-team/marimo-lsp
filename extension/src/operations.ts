import * as vscode from "vscode";
import { assert } from "./assert.ts";
import { Logger } from "./logging.ts";
import { type CellRuntimeState, CellStateManager } from "./shared/cells.ts";
import type { CellMessage, MessageOperation } from "./types.ts";

export interface OperationContext {
  notebook: vscode.NotebookDocument;
  controller: vscode.NotebookController;
  executions: Map<string, vscode.NotebookCellExecution>;
}

export async function route(
  context: OperationContext,
  operation: MessageOperation,
): Promise<void> {
  Logger.trace("Operation.Router", `Received: ${operation.op}`, operation);
  switch (operation.op) {
    case "cell-op": {
      handleCellOperation(context, operation);
      break;
    }

    default:
      Logger.warn(
        "Operation.Router",
        `Unknown operation: ${operation.op}`,
        operation,
      );
  }
}

const cellStateManager = new CellStateManager();

async function handleCellOperation(
  context: OperationContext,
  data: CellMessage,
): Promise<void> {
  const { cell_id: cellId, status, timestamp = 0 } = data;
  const state = cellStateManager.handleCellOp(data);

  switch (status) {
    case "queued": {
      const execution = context.controller.createNotebookCellExecution(
        getNotebookCell(context.notebook, cellId),
      );
      context.executions.set(cellId, execution);
      return;
    }

    case "running": {
      const execution = context.executions.get(cellId);
      assert(execution, `Expected execution for ${cellId}`);
      execution.start(timestamp * 1000);
      // MUST modify cell output after `NotebookCellExecution.start`
      await updateOrCreateMarimoCellOutput(execution, { cellId, state });
      return;
    }

    case "idle": {
      const execution = context.executions.get(cellId);
      assert(execution, `Expected execution for ${cellId}`);
      // MUST modify cell output before `NotebookCellExecution.end`
      await updateOrCreateMarimoCellOutput(execution, { cellId, state });
      execution.end(true, timestamp * 1000);
      context.executions.delete(cellId);
      return;
    }

    default: {
      const execution = context.executions.get(cellId);
      if (execution) {
        await updateOrCreateMarimoCellOutput(execution, { cellId, state });
      }
      return;
    }
  }
}

async function updateOrCreateMarimoCellOutput(
  execution: vscode.NotebookCellExecution,
  payload: {
    cellId: string;
    state: CellRuntimeState;
  },
) {
  await execution.replaceOutput(
    new vscode.NotebookCellOutput([
      vscode.NotebookCellOutputItem.json(
        payload,
        "application/vnd.marimo.ui+json",
      ),
    ]),
  );
}

function getNotebookCell(
  notebook: vscode.NotebookDocument,
  cellId: string,
): vscode.NotebookCell {
  const cell = notebook
    .getCells()
    .find((c) => c.document.uri.toString() === cellId);
  assert(cell, `No cell id ${cellId} in notebook ${notebook.uri.toString()} `);
  return cell;
}
