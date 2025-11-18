// @ts-expect-error
import { transitionCell as untypedTransitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts?nocheck";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import type {
  CellOutput,
  OutputMessage,
} from "@marimo-team/frontend/unstable_internal/core/kernel/messages.ts";
import {
  type Brand,
  Data,
  Effect,
  String as EffectString,
  HashMap,
  Option,
  Ref,
  Runtime,
} from "effect";
import type * as vscode from "vscode";
import {
  type CellMessage,
  type CellRuntimeState,
  createCellNavigationLink,
  getNotebookUri,
} from "../types.ts";
import { prettyErrorMessage } from "../utils/errors.ts";
import {
  extractCellId,
  getNotebookCell,
  type NotebookCellId,
} from "../utils/notebook.ts";
import { CellStateManager } from "./CellStateManager.ts";
import type { VenvPythonController } from "./NotebookControllerFactory.ts";
import type { SandboxController } from "./SandboxController.ts";
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
          HashMap.forEach(map, (entry) => {
            if (
              Option.isSome(entry.pendingExecution) &&
              entry.pendingExecution.value.kind !== "completed"
            ) {
              // Ensure all pending or running executions are ended
              entry.pendingExecution.value.end(false);
            }
          });
          return HashMap.empty();
        }),
      );

      const runtime = yield* Effect.runtime();
      const runFork = Runtime.runFork(runtime);

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
        handleCellOperation: (
          msg: CellMessage,
          options: {
            editor: vscode.NotebookEditor;
            controller: VenvPythonController | SandboxController;
          },
        ) =>
          Effect.gen(function* () {
            const { editor, controller } = options;
            const cellId = extractCellId(msg);

            const cell = yield* Ref.modify(ref, (map) => {
              const prev = Option.match(HashMap.get(map, cellId), {
                onSome: (cell) => cell,
                onNone: () => CellEntry.make(cellId, editor),
              });
              const update = CellEntry.transition(prev, msg);
              return [update, HashMap.set(map, cellId, update)];
            });

            const notebookUri = getNotebookUri(editor.notebook);
            const notebookCell = yield* getNotebookCell(
              editor.notebook,
              cell.id,
            );

            // If cell has stale inputs, mark it as stale
            if (cell.state.staleInputs) {
              yield* cellStateManager.markCellStale(
                notebookUri,
                notebookCell.index,
              );
            }

            switch (msg.status) {
              case "queued": {
                // Clear stale state when cell is queued for execution
                yield* cellStateManager.clearCellStale(
                  notebookUri,
                  notebookCell.index,
                );

                yield* Ref.update(ref, (map) => {
                  const handle = HashMap.get(map, cellId).pipe(
                    Option.andThen((v) => v.pendingExecution),
                  );
                  if (
                    Option.isSome(handle) &&
                    handle.value.kind !== "completed"
                  ) {
                    // Need to clear existing
                    handle.value.end(true);
                  }
                  const update = CellEntry.withExecution(
                    cell,
                    new PendingExecutionHandle({
                      runId: Option.getOrThrow(extractRunId(msg)),
                      inner:
                        controller.createNotebookCellExecution(notebookCell),
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
                yield* CellEntry.maybeUpdateCellOutput(update, code, options);
                return;
              }

              case "idle": {
                if (Option.isNone(cell.pendingExecution)) {
                  yield* Effect.logWarning(
                    "Got idle message but no cell execution found.",
                  );
                }
                // MUST modify cell output before `ExecutionHandle.end`
                yield* CellEntry.maybeUpdateCellOutput(cell, code, options);

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
                      EffectString.Equivalence,
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
                yield* CellEntry.maybeUpdateCellOutput(cell, code, options);
              }
            }
          }).pipe(
            Effect.catchTag("NotebookCellNotFoundError", (e) => {
              return Effect.logWarning(
                "Notebook cell not found for cell operation",
              ).pipe(Effect.annotateLogs({ cellId: e.cellId, op: msg.op }));
            }),
          ),
      };
    }),
  },
) {}

class PendingExecutionHandle extends Data.TaggedClass(
  "PendingExecutionHandle",
)<{
  readonly inner: vscode.NotebookCellExecution;
  readonly runId: RunId;
}> {
  readonly kind = "pending";
  start(startTime: number) {
    this.inner.start(startTime);
    return new RunningExecutionHandle({
      inner: this.inner,
      runId: this.runId,
    });
  }
  end(success: boolean, endTime?: number) {
    this.inner.end(success, endTime);
    return new CompletedExecutionHandle({
      inner: this.inner,
      runId: this.runId,
    });
  }
}

class RunningExecutionHandle extends Data.TaggedClass(
  "RunningExecutionHandle",
)<{
  readonly inner: vscode.NotebookCellExecution;
  readonly runId: RunId;
}> {
  readonly kind = "running";
  end(success: boolean, endTime?: number) {
    this.inner.end(success, endTime);
    return new CompletedExecutionHandle({
      inner: this.inner,
      runId: this.runId,
    });
  }
  updateCellOutput(options: {
    cellId: NotebookCellId;
    state: CellRuntimeState;
    code: VsCode;
  }) {
    const { cellId, state, code } = options;
    const notebook = this.inner.cell.notebook;
    const outputs = buildCellOutputs(cellId, state, code, notebook);
    return Effect.tryPromise(() => this.inner.replaceOutput(outputs)).pipe(
      Effect.catchAllCause((cause) =>
        Effect.logError("Failed to update cell output", cause).pipe(
          Effect.annotateLogs({ cellId }),
        ),
      ),
    );
  }
}

class CompletedExecutionHandle extends Data.TaggedClass(
  "CompletedExecutionHandle",
)<{
  readonly inner: vscode.NotebookCellExecution;
  readonly runId: RunId;
}> {
  readonly kind = "completed";
}

type ExecutionHandle =
  | PendingExecutionHandle
  | RunningExecutionHandle
  | CompletedExecutionHandle;

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
    if (
      Option.isSome(cell.pendingExecution) &&
      cell.pendingExecution.value.kind !== "completed"
    ) {
      cell.pendingExecution.value.end(false);
    }
    return new CellEntry({
      ...cell,
      pendingExecution: Option.none(),
    });
  }
  static start(cell: CellEntry, timestamp: number) {
    let pendingExecution = cell.pendingExecution;
    if (
      Option.isSome(cell.pendingExecution) &&
      cell.pendingExecution.value.kind === "pending"
    ) {
      pendingExecution = Option.some(
        cell.pendingExecution.value.start(timestamp * 1000),
      );
    }
    return new CellEntry({ ...cell, pendingExecution });
  }
  static end(cell: CellEntry, success: boolean, timestamp?: number) {
    if (
      Option.isSome(cell.pendingExecution) &&
      cell.pendingExecution.value.kind !== "completed"
    ) {
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
    deps?: {
      editor: vscode.NotebookEditor;
      controller: VenvPythonController | SandboxController;
    },
  ) {
    const { pendingExecution, id: cellId, state } = cell;

    if (Option.isNone(pendingExecution)) {
      // If it is an error, the cell likely never got queued and errored during compilation.
      // Create an ephemeral execution to display the error.
      const hasError = state.output?.channel === "marimo-error";

      if (hasError && deps) {
        yield* Effect.logDebug(
          "Creating ephemeral execution for marimo error without pending execution",
        ).pipe(Effect.annotateLogs({ cellId }));

        const notebookCell = yield* getNotebookCell(
          deps.editor.notebook,
          cellId,
        );
        const execution =
          deps.controller.createNotebookCellExecution(notebookCell);

        execution.start();
        const outputs = buildCellOutputs(
          cellId,
          state,
          code,
          deps.editor.notebook,
        );
        yield* Effect.tryPromise(() => execution.replaceOutput(outputs)).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError(
              "Failed to update cell output for ephemeral execution",
              cause,
            ).pipe(Effect.annotateLogs({ cellId })),
          ),
        );
        execution.end(false);

        return;
      }

      yield* Effect.logWarning("No pending execution to update.").pipe(
        Effect.annotateLogs({ cellId }),
      );
      return;
    }

    if (pendingExecution.value.kind !== "running") {
      yield* Effect.logDebug(
        "Pending execution is not running; skipping output update",
      ).pipe(Effect.annotateLogs({ cellId, status: state.status }));
      return;
    }

    yield* pendingExecution.value
      .updateCellOutput({
        cellId,
        state,
        code,
      })
      .pipe(
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

/* Type-safe wrapper around marimo's `transitionCell` we import above */
function transitionCell(
  cell: CellRuntimeState,
  message: CellMessage,
): CellRuntimeState {
  return untypedTransitionCell(cell, message);
}

/**
 * Builds VSCode NotebookCellOutput items from CellRuntimeState
 * Separates outputs by channel (stdout, stderr, marimo-error, etc.)
 */
export function buildCellOutputs(
  cellId: NotebookCellId,
  state: CellRuntimeState,
  code: VsCode,
  notebook?: vscode.NotebookDocument,
): vscode.NotebookCellOutput[] {
  const outputs: vscode.NotebookCellOutput[] = [];

  // Collect items by channel
  const stdoutItems: vscode.NotebookCellOutputItem[] = [];
  const stderrItems: vscode.NotebookCellOutputItem[] = [];
  const stdinItems: vscode.NotebookCellOutputItem[] = [];
  const errorItems: vscode.NotebookCellOutputItem[] = [];
  const outputItems: vscode.NotebookCellOutputItem[] = [];

  // Process console outputs (stdout, stderr, stdin)
  if (state.consoleOutputs) {
    for (const output of state.consoleOutputs) {
      const item = buildOutputItem(output, cellId, state, code, notebook);
      if (!item) continue;

      switch (output.channel) {
        case "stdout":
          stdoutItems.push(item);
          break;
        case "stderr":
          stderrItems.push(item);
          break;
        case "stdin":
          stdinItems.push(item);
          break;
      }
    }
  }

  // Process main output and errors
  if (state.output && !isOutputEmpty(state.output)) {
    const item = buildOutputItem(state.output, cellId, state, code, notebook);
    if (item) {
      if (state.output.channel === "marimo-error") {
        errorItems.push(item);
      } else {
        outputItems.push(item);
      }
    }
  }

  // Create NotebookCellOutputs for each channel with items
  if (errorItems.length > 0) {
    outputs.push(
      new code.NotebookCellOutput(errorItems, {
        channel: "marimo-error",
      }),
    );
  }

  if (stdoutItems.length > 0) {
    outputs.push(
      new code.NotebookCellOutput(stdoutItems, {
        channel: "stdout",
      }),
    );
  }

  if (stderrItems.length > 0) {
    outputs.push(
      new code.NotebookCellOutput(stderrItems, {
        channel: "stderr",
      }),
    );
  }

  if (stdinItems.length > 0) {
    outputs.push(
      new code.NotebookCellOutput(stdinItems, {
        channel: "stdin",
      }),
    );
  }

  if (outputItems.length > 0) {
    outputs.push(new code.NotebookCellOutput(outputItems));
  }

  return outputs;
}

/**
 * Creates a mapper function that converts cell URIs to clickable HTML links.
 *
 * Transforms error message cell references like "vscode-notebook-cell://...#W1sZmlsZQ%3D%3D"
 * into human-readable, clickable links like "<a ...>cell-2</a>".
 *
 * The links use onclick handlers to post messages to window.parent, which the renderer
 * catches and forwards to the extension. See types.ts for the full navigation flow.
 *
 * @param notebook - The notebook document containing the cells
 * @returns A function that maps cell URIs to HTML link strings
 */
function createCellIdMapper(
  notebook: vscode.NotebookDocument,
): (cellId: string) => string | undefined {
  return (cellUri: string) => {
    const cells = notebook.getCells();

    // Find the cell by matching its URI to get the visual index (0-based)
    const cellIndex = cells.findIndex(
      (cell) => cell.document.uri.toString() === cellUri,
    );
    if (cellIndex === -1) {
      return undefined;
    }
    return createCellNavigationLink(cellUri, cellIndex + 1);
  };
}

/**
 * Builds a single NotebookCellOutputItem from a CellOutput
 */
function buildOutputItem(
  output: CellOutput,
  cellId: NotebookCellId,
  state: CellRuntimeState,
  code: VsCode,
  notebook?: vscode.NotebookDocument,
): vscode.NotebookCellOutputItem | null {
  // Handle stdout/stderr with proper VSCode helpers
  if (output.mimetype === "text/plain") {
    const text = String(output.data);
    if (!text) {
      return null;
    }

    switch (output.channel) {
      case "stdout":
        return code.NotebookCellOutputItem.stdout(text);
      case "stderr":
        return code.NotebookCellOutputItem.stderr(text);
      case "stdin":
        return code.NotebookCellOutputItem.text(text, "text/plain");
    }
  }

  // Handle traceback
  if (output.mimetype === "application/vnd.marimo+traceback") {
    const text = String(output.data);
    if (!text) {
      return null;
    }
    return code.NotebookCellOutputItem.text(text, "text/html");
  }

  // Handle marimo errors
  if (output.channel === "marimo-error" && Array.isArray(output.data)) {
    // Convert marimo errors to VSCode Error objects
    const cellIdMapper = notebook ? createCellIdMapper(notebook) : undefined;
    const errors = output.data.map((error) => {
      const errorMessage = prettyErrorMessage(error, cellIdMapper);
      // If the error message contains HTML (links), use text/html mime type
      if (errorMessage.includes("<a href=")) {
        return code.NotebookCellOutputItem.text(errorMessage, "text/html");
      }
      return code.NotebookCellOutputItem.stderr(errorMessage);
    });
    return errors[0] || null;
  }

  if (isOutputEmpty(output)) {
    return null;
  }

  // Default pass to our renderer
  return code.NotebookCellOutputItem.json(
    { cellId, state },
    "application/vnd.marimo.ui+json",
  );
}

function isOutputEmpty(output: OutputMessage | undefined | null): boolean {
  if (output == null) {
    return true;
  }

  if (output.data == null || output.data === "") {
    return true;
  }

  return false;
}
