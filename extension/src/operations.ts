import { Effect } from "effect";
import type * as vscode from "vscode";

import { assert } from "./assert.ts";
import { NotebookRenderer } from "./services/NotebookRenderer.ts";
import { VsCode } from "./services/VsCode.ts";
import { type CellRuntimeState, CellStateManager } from "./shared/cells.ts";
import type { CellMessage, MessageOperation } from "./types.ts";

export interface OperationContext {
  editor: vscode.NotebookEditor;
  controller: vscode.NotebookController;
  executions: Map<string, vscode.NotebookCellExecution>;
}

export function routeOperation(
  context: OperationContext,
  operation: MessageOperation,
): Effect.Effect<void, never, NotebookRenderer | VsCode> {
  return Effect.gen(function* () {
    const renderer = yield* NotebookRenderer;
    const code = yield* VsCode;

    switch (operation.op) {
      case "cell-op": {
        yield* handleCellOperation(code, context, operation);
        return;
      }
      // Forward to renderer (front end)
      case "remove-ui-elements":
      case "function-call-result":
      case "send-ui-element-message": {
        yield* Effect.logTrace("Forwarding message to renderer").pipe(
          Effect.annotateLogs({ op: operation.op }),
        );
        yield* renderer.postMessage(operation, context.editor);
        return;
      }
      case "interrupted": {
        // Clear all pending executions when run is interrupted
        const executionCount = context.executions.size;
        for (const execution of context.executions.values()) {
          execution.end(false, Date.now());
        }
        context.executions.clear();
        yield* Effect.logInfo("Run completed").pipe(
          Effect.annotateLogs({
            op: operation.op,
            clearedExecutions: executionCount,
          }),
        );
        return;
      }
      case "completed-run": {
        return;
      }
      default: {
        yield* Effect.logWarning("Unknown operation").pipe(
          Effect.annotateLogs({ op: operation.op }),
        );
        return;
      }
    }
  }).pipe(Effect.annotateLogs({ component: "operations" }));
}

const cellStateManager = new CellStateManager();

function handleCellOperation(
  code: VsCode,
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
          getNotebookCell(context.editor.notebook, cellId),
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
        yield* updateOrCreateMarimoCellOutput(code, execution, {
          cellId,
          state,
        });
        return;
      }

      case "idle": {
        const execution = context.executions.get(cellId);
        assert(execution, `Expected execution for ${cellId}`);
        // MUST modify cell output before `NotebookCellExecution.end`
        yield* updateOrCreateMarimoCellOutput(code, execution, {
          cellId,
          state,
        });
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
          yield* updateOrCreateMarimoCellOutput(code, execution, {
            cellId,
            state,
          });
        }
        return;
      }
    }
  });
}

function updateOrCreateMarimoCellOutput(
  code: VsCode,
  execution: vscode.NotebookCellExecution,
  payload: {
    cellId: string;
    state: CellRuntimeState;
  },
): Effect.Effect<void, never, never> {
  return Effect.tryPromise(() =>
    execution.replaceOutput(
      new code.NotebookCellOutput([
        code.NotebookCellOutputItem.json(
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
