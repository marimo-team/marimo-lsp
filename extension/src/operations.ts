import * as vscode from "vscode";
import { assert } from "./assert.ts";
import { Logger } from "./logging.ts";
import { CellStateManager } from "./shared/cells.ts";
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
  executions: Map<
    string,
    { exec: vscode.NotebookCellExecution; started: boolean }
  >;
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
  const state = cellStateManager.handleCellOp(data);
  const { cell_id: cellId, status, timestamp } = data;

  if (status === "queued") {
    Logger.debug("Cell.State", `Queued: ${cellId}`);
    context.executions.set(cellId, {
      started: false,
      exec: context.controller.createNotebookCellExecution(
        getNotebookCell(context.notebookUri, cellId),
      ),
    });
    Logger.debug("Cell.Operation.Complete", `status=queued cell_id=${cellId}`);
  }

  switch (status) {
    case "running": {
      const execution = context.executions.get(cellId);
      assert(execution, `Expected execution for ${cellId}`);
      Logger.debug("Cell.State", `Running: ${cellId}`);
      execution.exec.start(timestamp * 1000);
      execution.started = true;
      break;
    }

    case "idle": {
      const execution = context.executions.get(cellId);
      assert(execution, `Expected execution for ${cellId}`);
      Logger.debug("Cell.State", `Completed: ${cellId}`);
      execution.exec.end(true, timestamp * 1000);
      context.executions.delete(cellId);
      Logger.debug("Cell.Operation.Complete", `status=idle cell_id=${cellId}`);
      break;
    }
  }

  const execution = context.executions.get(cellId);
  if (execution?.started) {
    await execution.exec.replaceOutput(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(
          state,
          "application/vnd.marimo.ui+json",
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
  const cell = notebook
    .getCells()
    .find((c) => c.document.uri.toString() === cellId);
  assert(cell, `No cell id ${cellId} in notebook ${notebookUri} `);
  return cell;
}
