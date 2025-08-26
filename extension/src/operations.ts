import * as vscode from "vscode";
import { assert } from "./assert.ts";
import { Logger } from "./logging.ts";
import { type CellRuntimeState, CellStateManager } from "./shared/cells.ts";
import type {
  MessageOperation,
  MessageOperationData,
  MessageOperationType,
} from "./types.ts";

export type OperationMessage = {
  [Type in MessageOperationType]: {
    op: Type;
    data: Omit<Extract<MessageOperation, { name: Type }>, "name">;
  };
}[MessageOperationType];

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
    case "cell-op": {
      handleCellOperation(context, operation.data);
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
  data: MessageOperationData<"cell-op">,
): Promise<void> {
  const { cell_id: cellId, status, timestamp } = data;
  const state = cellStateManager.handleCellOp(data);

  switch (status) {
    case "queued": {
      const execution = context.controller.createNotebookCellExecution(
        getNotebookCell(context.notebookUri, cellId),
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
  const cell = notebook
    .getCells()
    .find((c) => c.document.uri.toString() === cellId);
  assert(cell, `No cell id ${cellId} in notebook ${notebookUri} `);
  return cell;
}
