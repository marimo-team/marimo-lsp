import { type Brand, Data, Effect, HashMap, Option, Ref } from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import {
  type CellRuntimeState,
  createCellRuntimeState,
  transitionCell,
} from "../shared/cells.ts";
import type { CellMessage } from "../types.ts";
import type { NotebookController } from "./NotebookControllers.ts";
import { VsCode } from "./VsCode.ts";

export class ExecutionRegistry extends Effect.Service<ExecutionRegistry>()(
  "ExecutionRegistry",
  {
    dependencies: [VsCode.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const ref = yield* Ref.make(HashMap.empty<NotebookCellId, CellEntry>());
      yield* Effect.addFinalizer(() =>
        Ref.update(ref, (map) => {
          HashMap.forEach(map, (entry) =>
            Option.map(entry.pendingExecution, (e) => e.end(true)),
          );
          return HashMap.empty();
        }),
      );
      return {
        handleInterrupted: Effect.fnUntraced(function* (
          editor: vscode.NotebookEditor,
        ) {
          yield* Ref.update(ref, (map) =>
            HashMap.map(map, (cell) => {
              if (
                cell.editor === editor &&
                Option.isSome(cell.pendingExecution)
              ) {
                return CellEntry.interrupt(cell);
              } else {
                return cell;
              }
            }),
          );
        }),
        handleCellOperation: Effect.fnUntraced(function* (
          msg: CellMessage,
          deps: {
            editor: vscode.NotebookEditor;
            controller: NotebookController;
          },
        ) {
          const { editor, controller } = deps;
          const cellId = extractCellId(msg);

          const cell = yield* Ref.modify(ref, (map) => {
            const prev = Option.match(HashMap.get(map, cellId), {
              onSome: (cell) => cell,
              onNone: () => CellEntry.make(cellId, deps.editor),
            });
            const update = CellEntry.transition(prev, msg);
            return [update, HashMap.set(map, cellId, update)];
          });

          switch (msg.status) {
            case "queued": {
              yield* Ref.update(ref, (map) => {
                const update = CellEntry.withExecution(
                  cell,
                  new ExecutionHandle({
                    runId: Option.getOrThrow(extractRunId(msg)),
                    inner: controller.inner.createNotebookCellExecution(
                      getNotebookCell(editor.notebook, cell.id),
                    ),
                  }),
                );
                return HashMap.set(map, cellId, update);
              });
              yield* Effect.logDebug("Cell queued for execution").pipe(
                Effect.annotateLogs({ cellId }),
              );
              return;
            }

            case "running": {
              const update = yield* Ref.modify(ref, (map) => {
                const update = CellEntry.start(cell, msg.timestamp ?? 0);
                return [update, HashMap.set(map, cellId, update)];
              });
              yield* Effect.logDebug("Cell execution started").pipe(
                Effect.annotateLogs({ cellId }),
              );
              yield* CellEntry.maybeUpdateCellOutput(update, code);
              return;
            }

            case "idle": {
              // MUST modify cell output before `ExecutionHandle.end`
              yield* CellEntry.maybeUpdateCellOutput(cell, code);
              yield* Ref.update(ref, (map) =>
                HashMap.set(
                  map,
                  cellId,
                  CellEntry.end(cell, true, msg.timestamp),
                ),
              );
              yield* Effect.logDebug("Cell execution completed").pipe(
                Effect.annotateLogs({ cellId }),
              );
              return;
            }

            default: {
              yield* CellEntry.maybeUpdateCellOutput(cell, code);
            }
          }
        }),
      };
    }),
  },
) {}

class ExecutionHandle extends Data.TaggedClass("ExecutionHandle")<{
  readonly inner: vscode.NotebookCellExecution;
  readonly runId: RunId;
}> {
  start(startTime: number) {
    return this.inner.start(startTime);
  }
  end(success: boolean, endTime?: number) {
    return this.inner.end(success, endTime);
  }
  static updateCellOutput = Effect.fnUntraced(function* (
    execution: ExecutionHandle,
    options: {
      cellId: NotebookCellId;
      state: CellRuntimeState;
      code: VsCode;
    },
  ) {
    const { cellId, state, code } = options;
    yield* Effect.tryPromise(() =>
      execution.inner.replaceOutput(
        new code.NotebookCellOutput([
          code.NotebookCellOutputItem.json(
            { cellId, state },
            "application/vnd.marimo.ui+json",
          ),
        ]),
      ),
    ).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError("Failed to update cell output", cause).pipe(
          Effect.annotateLogs({ cellId }),
        ),
      ),
    );
  });
}

class CellEntry extends Data.TaggedClass("CellEntry")<{
  readonly id: NotebookCellId;
  readonly state: CellRuntimeState;
  readonly editor: vscode.NotebookEditor;
  readonly pendingExecution: Option.Option<ExecutionHandle>;
}> {
  static make(id: NotebookCellId, editor: vscode.NotebookEditor) {
    return new CellEntry({
      id,
      editor,
      state: createCellRuntimeState(),
      pendingExecution: Option.none(),
    });
  }
  static transition(cell: CellEntry, message: CellMessage) {
    return new CellEntry({
      ...cell,
      state: transitionCell(cell.state, message),
    });
  }
  static withExecution(cell: CellEntry, execution: ExecutionHandle) {
    return new CellEntry({
      ...cell,
      pendingExecution: Option.some(execution),
    });
  }
  static interrupt(cell: CellEntry) {
    if (Option.isSome(cell.pendingExecution)) {
      cell.pendingExecution.value.end(false);
    }
    return new CellEntry({
      ...cell,
      pendingExecution: Option.none(),
    });
  }
  static start(cell: CellEntry, timestamp: number) {
    assert(
      Option.isSome(cell.pendingExecution),
      `Expected execution for ${cell.id}`,
    );
    cell.pendingExecution.value.inner.start(timestamp * 1000);
    return new CellEntry({ ...cell });
  }
  static end(cell: CellEntry, success: boolean, timestamp?: number) {
    assert(
      Option.isSome(cell.pendingExecution),
      `Expected execution for ${cell.id}`,
    );
    cell.pendingExecution.value.inner.end(
      success,
      timestamp ? timestamp * 1000 : undefined,
    );
    return new CellEntry({
      ...cell,
      pendingExecution: Option.none(),
    });
  }
  static maybeUpdateCellOutput = Effect.fnUntraced(function* (
    cell: CellEntry,
    code: VsCode,
  ) {
    const { pendingExecution, id: cellId, state } = cell;
    if (Option.isNone(pendingExecution)) {
      yield* Effect.logWarning("No pending execution to update.");
      return;
    }
    yield* ExecutionHandle.updateCellOutput(pendingExecution.value, {
      cellId,
      state,
      code,
    }).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError("Failed to update cell output", cause).pipe(
          Effect.annotateLogs({ cellId }),
        ),
      ),
    );
  });
}

type RunId = Brand.Branded<string, "RunId">;
function extractRunId(msg: CellMessage) {
  return Option.fromNullable(msg.run_id) as Option.Option<RunId>;
}

type NotebookCellId = Brand.Branded<string, "CellId">;
function extractCellId(msg: CellMessage) {
  return msg.cell_id as NotebookCellId;
}

function getNotebookCell(
  notebook: vscode.NotebookDocument,
  cellId: NotebookCellId,
): vscode.NotebookCell {
  const cell = notebook
    .getCells()
    .find((c) => c.document.uri.toString() === cellId);
  assert(cell, `No cell id ${cellId} in notebook ${notebook.uri.toString()} `);
  return cell;
}
