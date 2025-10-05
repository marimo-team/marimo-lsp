import {
  type Brand,
  Data,
  Effect,
  FiberSet,
  HashMap,
  Option,
  Ref,
  String,
} from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import {
  type CellRuntimeState,
  createCellRuntimeState,
  transitionCell,
} from "../utils/transitionCell.ts";
import { type CellMessage, getNotebookUri } from "../types.ts";
import { CellStateManager } from "./CellStateManager.ts";
import type { NotebookController } from "./NotebookControllerFactory.ts";
import { VsCode } from "./VsCode.ts";

export class ExecutionRegistry extends Effect.Service<ExecutionRegistry>()(
  "ExecutionRegistry",
  {
    dependencies: [CellStateManager.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const cellStateManager = yield* CellStateManager;
      const ref = yield* Ref.make(HashMap.empty<NotebookCellId, CellEntry>());

      yield* Effect.addFinalizer(() =>
        Ref.update(ref, (map) => {
          HashMap.forEach(map, (entry) =>
            Option.map(entry.pendingExecution, (e) => e.end(true)),
          );
          return HashMap.empty();
        }),
      );
      const runFork = yield* FiberSet.makeRuntime();
      return {
        handleInterrupted(editor: vscode.NotebookEditor) {
          return Ref.update(ref, (map) =>
            HashMap.map(map, (cell) =>
              Option.match(cell.pendingExecution, {
                onSome: () => cell.editor === editor,
                onNone: () => false,
              })
                ? CellEntry.interrupt(cell)
                : cell,
            ),
          );
        },
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
              // Clear stale state when cell is queued for execution
              const notebookUri = getNotebookUri(editor.notebook);
              const notebookCell = getNotebookCell(editor.notebook, cell.id);
              yield* cellStateManager.clearCellStale(
                notebookUri,
                notebookCell.index,
              );

              yield* Ref.update(ref, (map) => {
                const handle = HashMap.get(map, cellId).pipe(
                  Option.andThen((v) => v.pendingExecution),
                );
                if (Option.isSome(handle)) {
                  // Need to clear existing
                  handle.value.end(true);
                }
                const update = CellEntry.withExecution(
                  cell,
                  new ExecutionHandle({
                    runId: Option.getOrThrow(extractRunId(msg)),
                    inner: controller.createNotebookCellExecution(notebookCell),
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
              if (Option.isNone(cell.pendingExecution)) {
                yield* Effect.logWarning(
                  "Got running message but no cell execution found.",
                );
              }
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
              if (Option.isNone(cell.pendingExecution)) {
                yield* Effect.logWarning(
                  "Got idle message but no cell execution found.",
                );
              }
              // MUST modify cell output before `ExecutionHandle.end`
              yield* CellEntry.maybeUpdateCellOutput(cell, code);

              {
                // FIXME: stdin/stdout are flushed every 10ms, so wait 50ms
                // to ensure all related events arrive before finalizing.
                //
                // marimo doesn't set a run_id for idle messages, so we can't compare
                // against the incoming message to detect if a new execution has started.
                //
                // Ref: https://github.com/marimo-team/marimo/blob/3644b6f/marimo/_messaging/ops.py#L148-L151
                //
                // Instead, we capture the `lastRunId` before the timeout and compare it
                // when finalizing. If a new execution starts before the timeout fires,
                // the `lastRunId` will have changed and we skip finalization.
                const lastRunId = cell.lastRunId;
                const finalize = Ref.update(ref, (map) => {
                  const fresh = HashMap.get(map, cellId);

                  if (Option.isNone(fresh)) {
                    return map;
                  }

                  const isDifferentRun = !Option.getEquivalence(
                    String.Equivalence,
                  )(fresh.value.lastRunId, lastRunId);

                  if (isDifferentRun) {
                    return map;
                  }

                  return HashMap.set(
                    map,
                    cellId,
                    CellEntry.end(fresh.value, true, msg.timestamp),
                  );
                });

                setTimeout(() => runFork(finalize), 50);
              }

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
  readonly lastRunId: Option.Option<RunId>;
}> {
  static make(id: NotebookCellId, editor: vscode.NotebookEditor) {
    return new CellEntry({
      id,
      editor,
      state: createCellRuntimeState(),
      pendingExecution: Option.none(),
      lastRunId: Option.none(),
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
      lastRunId: Option.some(execution.runId),
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
    if (Option.isSome(cell.pendingExecution)) {
      cell.pendingExecution.value.inner.start(timestamp * 1000);
    }
    return new CellEntry({ ...cell });
  }
  static end(cell: CellEntry, success: boolean, timestamp?: number) {
    if (Option.isSome(cell.pendingExecution)) {
      cell.pendingExecution.value.inner.end(
        success,
        timestamp ? timestamp * 1000 : undefined,
      );
    }
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
