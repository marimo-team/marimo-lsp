import { Effect } from "effect";
import * as vscode from "vscode";

import { assert } from "./assert.ts";
import { MarimoNotebookRenderer } from "./services/MarimoNotebookRenderer.ts";
import { type CellRuntimeState, CellStateManager } from "./shared/cells.ts";
import type { CellMessage, MessageOperation } from "./types.ts";

export interface OperationContext {
  notebook: vscode.NotebookDocument;
  controller: vscode.NotebookController;
  executions: Map<string, vscode.NotebookCellExecution>;
}

export function routeOperation(
  context: OperationContext,
  operation: MessageOperation,
): Effect.Effect<void, never, MarimoNotebookRenderer> {
  return Effect.gen(function* () {
    const renderer = yield* MarimoNotebookRenderer;

    switch (operation.op) {
      case "cell-op": {
        return yield* handleCellOperation(context, operation);
      }
      // Forward to renderer (front end)
      case "remove-ui-elements":
      case "send-ui-element-message": {
        yield* Effect.logTrace("Forwarding message to renderer").pipe(
          Effect.annotateLogs({ op: operation.op }),
        );
        return yield* renderer.postMessage(operation);
      }
      case "interrupted":
      case "completed-run": {
        // Clear all pending executions when run is completed/interrupted
        const executionCount = context.executions.size;
        for (const [_cellId, execution] of context.executions) {
          execution.end(false, Date.now());
        }
        context.executions.clear();
        yield* Effect.logInfo("Run completed").pipe(
          Effect.annotateLogs({
            op: operation.op,
            clearedExecutions: executionCount,
          }),
        );
        return yield* Effect.void;
      }
      default:
        return yield* Effect.logWarning("Unknown operation").pipe(
          Effect.annotateLogs({ op: operation.op }),
        );
    }
  }).pipe(Effect.annotateLogs({ component: "operations" }));
}

const cellStateManager = new CellStateManager();

function handleCellOperation(
  context: OperationContext,
  data: CellMessage,
): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const { cell_id: cellId, status, timestamp = 0 } = data;
    yield* Effect.logTrace("Handling cell operation").pipe(
      Effect.annotateLogs({ cellId, status }),
    );
    const state = cellStateManager.handleCellOp(data);

    switch (status) {
      case "queued": {
        const execution = context.controller.createNotebookCellExecution(
          getNotebookCell(context.notebook, cellId),
        );
        context.executions.set(cellId, execution);
        yield* Effect.logDebug("Cell queued for execution").pipe(
          Effect.annotateLogs({ cellId }),
        );
        return yield* Effect.void;
      }

      case "running": {
        const execution = context.executions.get(cellId);
        assert(execution, `Expected execution for ${cellId}`);
        execution.start(timestamp * 1000);
        yield* Effect.logDebug("Cell execution started").pipe(
          Effect.annotateLogs({ cellId }),
        );
        // MUST modify cell output after `NotebookCellExecution.start`
        yield* updateOrCreateMarimoCellOutput(execution, { cellId, state });
        return;
      }

      case "idle": {
        const execution = context.executions.get(cellId);
        assert(execution, `Expected execution for ${cellId}`);
        // MUST modify cell output before `NotebookCellExecution.end`
        yield* updateOrCreateMarimoCellOutput(execution, { cellId, state });
        execution.end(true, timestamp * 1000);
        context.executions.delete(cellId);
        yield* Effect.logDebug("Cell execution completed").pipe(
          Effect.annotateLogs({ cellId }),
        );
        return;
      }

      default: {
        const execution = context.executions.get(cellId);
        if (execution) {
          yield* updateOrCreateMarimoCellOutput(execution, { cellId, state });
        }
        return;
      }
    }
  });
}

function updateOrCreateMarimoCellOutput(
  execution: vscode.NotebookCellExecution,
  payload: {
    cellId: string;
    state: CellRuntimeState;
  },
): Effect.Effect<void, never, never> {
  return Effect.tryPromise(() =>
    execution.replaceOutput(
      new vscode.NotebookCellOutput([
        vscode.NotebookCellOutputItem.json(
          payload,
          "application/vnd.marimo.ui+json",
        ),
      ]),
    ),
  ).pipe(
    Effect.catchAllCause((cause) =>
      Effect.logError("Failed to update cell output", cause).pipe(
        Effect.annotateLogs({ cellId: payload.cellId }),
      ),
    ),
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
