// @ts-expect-error
import { transitionCell as untypedTransitionCell } from "@marimo-team/frontend/unstable_internal/core/cells/cell.ts?nocheck";
import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import type {
  CellOutput,
  OutputMessage,
} from "@marimo-team/frontend/unstable_internal/core/kernel/messages.ts";
import { Brand, Cause, Data, Effect, HashMap, Option, Ref } from "effect";
import type * as vscode from "vscode";

import { logUnreachable } from "../assert.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { prettyErrorMessage } from "../lib/errors.ts";
import { parseTraceback } from "../lib/tracebacks.ts";
import { CellStateManager } from "../notebook/CellStateManager.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  findNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  extractCellIdFromCellMessage,
  type NotebookCellId,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  type CellOperationNotification,
  type CellRuntimeState,
  createCellNavigationLink,
} from "../types.ts";
import type { PythonController } from "./NotebookControllerFactory.ts";
import type { SandboxController } from "./SandboxController.ts";

/**
 * Thrown when VS Code's `createNotebookCellExecution` fails because the cell
 * is no longer part of the notebook (e.g., deleted between the time we looked
 * it up and the time we tried to create an execution for it).
 */
export class InvalidCellError extends Data.TaggedError("InvalidCellError")<{
  readonly cellId: NotebookCellId;
  readonly cause: unknown;
}> {}

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
          msg: CellOperationNotification,
          options: {
            editor: vscode.NotebookEditor;
            controller: PythonController | SandboxController;
          },
        ) =>
          Effect.gen(function* () {
            const { editor, controller } = options;
            const cellId = extractCellIdFromCellMessage(msg);

            const cell = yield* Ref.modify(ref, (map) => {
              const prev = Option.match(HashMap.get(map, cellId), {
                onSome: (cell) => cell,
                onNone: () => CellEntry.make(cellId, editor),
              });
              const update = CellEntry.transition(prev, msg);
              return [update, HashMap.set(map, cellId, update)];
            });

            const notebook = MarimoNotebookDocument.from(editor.notebook);
            const notebookCell = yield* findNotebookCell(notebook, cell.id);

            // If cell has stale inputs, invalidate its execution record
            if (cell.state.staleInputs) {
              yield* cellStateManager.invalidateCell(notebookCell);
            }

            switch (msg.status) {
              case "queued": {
                const runIdOpt = extractRunId(msg);
                if (Option.isNone(runIdOpt)) {
                  yield* Effect.logWarning(
                    "Queued cell-op missing run_id; cannot track execution",
                  ).pipe(Effect.annotateLogs({ cellId, status: msg.status }));
                  return;
                }
                const runId = runIdOpt.value;

                // Record execution — clears stale state
                yield* cellStateManager.recordExecution(notebookCell);

                // End any in-progress execution before creating a new one
                yield* Ref.update(ref, (map) => {
                  const handle = HashMap.get(map, cellId).pipe(
                    Option.andThen((v) => v.pendingExecution),
                  );
                  if (
                    Option.isSome(handle) &&
                    handle.value.kind !== "completed"
                  ) {
                    handle.value.end(true);
                  }
                  return map;
                });

                // Create new execution — can fail if the cell was removed
                const execution = yield* Effect.try({
                  try: () =>
                    controller.createNotebookCellExecution(notebookCell),
                  catch: (cause) => new InvalidCellError({ cellId, cause }),
                });

                yield* Ref.update(ref, (map) =>
                  HashMap.set(
                    map,
                    cellId,
                    CellEntry.withExecution(
                      cell,
                      new PendingExecutionHandle({
                        runId,
                        inner: execution,
                      }),
                    ),
                  ),
                );
                return;
              }

              case "running": {
                if (Option.isNone(cell.pendingExecution)) {
                  yield* Effect.logWarning(
                    "Got running message but no cell execution found",
                  );
                }
                const update = yield* Ref.modify(ref, (map) => {
                  const update = CellEntry.start(cell, msg.timestamp ?? 0);
                  return [update, HashMap.set(map, cellId, update)];
                });
                yield* CellEntry.maybeUpdateCellOutput(update, code, options);
                return;
              }

              case "idle": {
                if (Option.isNone(cell.pendingExecution)) {
                  yield* Effect.logWarning(
                    "Got idle message but no cell execution found",
                  );
                }
                // MUST modify cell output before `ExecutionHandle.end`
                yield* CellEntry.maybeUpdateCellOutput(cell, code, options);
                yield* Ref.update(ref, (map) =>
                  Option.match(HashMap.get(map, cellId), {
                    onSome: (entry) =>
                      HashMap.set(
                        map,
                        cellId,
                        CellEntry.end(entry, true, msg.timestamp),
                      ),
                    onNone: () => map,
                  }),
                );
                return;
              }

              default: {
                yield* CellEntry.maybeUpdateCellOutput(cell, code, options);
              }
            }
          }).pipe(
            Effect.catchTag("NotebookCellNotFoundError", () =>
              Effect.logWarning("Notebook cell not found for cell operation"),
            ),
            Effect.catchTag("InvalidCellError", (error) =>
              Effect.logWarning(
                "Cell is no longer valid, skipping execution",
              ).pipe(Effect.annotateLogs({ cause: Cause.fail(error.cause) })),
            ),
            Effect.annotateLogs({ cellId: extractCellIdFromCellMessage(msg) }),
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
      Effect.annotateLogs({ cellId }),
      Effect.catchAllCause((cause) =>
        // Race condition: execution may have been ended by a concurrent
        // operation (e.g., a new queued message ending the old execution).
        // This is expected and not an actionable error.
        Effect.logWarning("Failed to update cell output").pipe(
          Effect.annotateLogs({ cause }),
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
}> {
  static make(id: NotebookCellId, editor: vscode.NotebookEditor) {
    return new CellEntry({
      id,
      editor,
      state: createCellRuntimeState(),
      pendingExecution: Option.none(),
    });
  }
  private with(
    overrides: Partial<Pick<CellEntry, "state" | "pendingExecution">>,
  ) {
    return new CellEntry({
      id: this.id,
      editor: this.editor,
      state: overrides.state ?? this.state,
      pendingExecution: overrides.pendingExecution ?? this.pendingExecution,
    });
  }
  static transition(cell: CellEntry, message: CellOperationNotification) {
    return cell.with({ state: transitionCell(cell.state, message) });
  }
  static withExecution(cell: CellEntry, execution: ExecutionHandle) {
    return cell.with({
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
    return cell.with({ pendingExecution: Option.none() });
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
    return cell.with({ pendingExecution });
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
    return cell.with({ pendingExecution: Option.none() });
  }
  static maybeUpdateCellOutput = Effect.fn(function* (
    cell: CellEntry,
    code: VsCode,
    deps?: {
      editor: vscode.NotebookEditor;
      controller: PythonController | SandboxController;
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
        );

        const notebookCell = yield* findNotebookCell(
          MarimoNotebookDocument.from(deps.editor.notebook),
          cellId,
        );
        const execution = yield* Effect.try({
          try: () => deps.controller.createNotebookCellExecution(notebookCell),
          catch: (cause) => new InvalidCellError({ cellId, cause }),
        });

        execution.start();
        const outputs = buildCellOutputs(
          cellId,
          state,
          code,
          deps.editor.notebook,
        );
        yield* Effect.tryPromise(() => execution.replaceOutput(outputs)).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logWarning(
              "Failed to update cell output for ephemeral execution",
              cause,
            ),
          ),
        );
        execution.end(false);

        return;
      }

      yield* Effect.logWarning("No pending execution to update");
      return;
    }

    if (pendingExecution.value.kind !== "running") {
      yield* Effect.logDebug(
        "Pending execution is not running, skipping output update",
      ).pipe(Effect.annotateLogs({ status: state.status }));
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
          Effect.logWarning("Failed to update cell output").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
        Effect.annotateLogs({ cellId }),
      );
  });
}

type RunId = Brand.Branded<string, "RunId">;
const RunId = Brand.nominal<RunId>();
function extractRunId(msg: CellOperationNotification): Option.Option<RunId> {
  return Option.fromNullable(msg.run_id).pipe(
    Option.map((idStr) => RunId(idStr)),
  );
}

/* Type-safe wrapper around marimo's `transitionCell` we import above */
function transitionCell(
  cell: CellRuntimeState,
  message: CellOperationNotification,
): CellRuntimeState {
  return untypedTransitionCell(cell, message);
}

/**
 * Convert CellOperationNotification(s) to VSCode NotebookCellOutput.
 *
 * Returns None if no outputs, Some if there are outputs.
 */
export function scratchCellNotificationsToVsCodeOutput(
  notifications:
    | CellOperationNotification
    | readonly CellOperationNotification[],
  code: VsCode,
) {
  const arr = Array.isArray(notifications) ? notifications : [notifications];
  const outputs = buildCellOutputs(
    // @ts-expect-error - special cell id for scratch pad
    SCRATCH_CELL_ID,
    arr.reduce(transitionCell, createCellRuntimeState()),
    code,
  );
  const items = outputs.flatMap((o) => o.items);
  if (items.length === 0) {
    return Option.none<vscode.NotebookCellOutput>();
  }
  return Option.some(new code.NotebookCellOutput(items));
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
      // Remove main output so it is not displayed in the console output location
      const stateWithoutOutputs = { ...state, output: null };
      const item = buildOutputItem(
        output,
        cellId,
        stateWithoutOutputs,
        code,
        notebook,
      );
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
        case "media":
          stdoutItems.push(item);
          break;
        case "output":
        case "marimo-error":
        case "pdb":
          // PDB, output, and pdb not expected from console outputs
          break;
        default:
          logUnreachable(output.channel);
      }
    }
  }

  // Process main output and errors
  if (state.output && !isOutputEmpty(state.output)) {
    // Remove console outputs so they are not displayed in the cell output location
    const stateWithoutConsoleOutputs = { ...state, consoleOutputs: [] };
    const item = buildOutputItem(
      state.output,
      cellId,
      stateWithoutConsoleOutputs,
      code,
      notebook,
    );
    if (item) {
      if (state.output.channel === "marimo-error") {
        errorItems.push(item);
      } else {
        outputItems.push(item);
      }
    }
  }

  // Create NotebookCellOutputs for each channel with items.
  //
  // marimo-error and a traceback are present, the traceback already renders
  // `<Type>: <message>` as its header, so the marimo-error item is dropped.
  if (errorItems.length > 0 && !shouldSuppressMarimoError(state)) {
    outputs.push(
      new code.NotebookCellOutput(errorItems, {
        channel: "marimo-error",
      }),
    );
  }

  if (outputItems.length > 0) {
    outputs.push(new code.NotebookCellOutput(outputItems));
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
const TRACEBACK_MIME = "application/vnd.marimo+traceback";

function hasTraceback(state: CellRuntimeState): boolean {
  if (state.output?.mimetype === TRACEBACK_MIME) return true;
  return (state.consoleOutputs ?? []).some(
    (o) => o?.mimetype === TRACEBACK_MIME,
  );
}

function shouldSuppressMarimoError(state: CellRuntimeState): boolean {
  const out = state.output;
  if (!out || out.channel !== "marimo-error" || !Array.isArray(out.data)) {
    return false;
  }
  const onlyExceptionLike = out.data.every(
    (e) =>
      e != null &&
      typeof e === "object" &&
      "type" in e &&
      (e.type === "exception" || e.type === "strict-exception"),
  );
  return onlyExceptionLike && hasTraceback(state);
}

function createCellIdToIndex(
  notebook: MarimoNotebookDocument,
): (cellId: string) => number | undefined {
  return (cellId: string) => {
    const cellIndex = notebook.getCells().findIndex((cell) =>
      Option.match(cell.id, {
        onSome: (id) => id === cellId,
        onNone: () => false,
      }),
    );
    return cellIndex === -1 ? undefined : cellIndex;
  };
}

function createCellIdMapper(
  notebook: MarimoNotebookDocument,
): (cellId: NotebookCellId) => string | undefined {
  return (cellId: NotebookCellId) => {
    // Find the cell by matching its URI to get the visual index (0-based)
    const cellIndex = notebook.getCells().findIndex((cell) =>
      Option.match(cell.id, {
        onSome: (id) => id === cellId,
        onNone: () => false,
      }),
    );
    if (cellIndex === -1) {
      return undefined;
    }
    return createCellNavigationLink(cellId, cellIndex + 1);
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
    const text =
      typeof output.data === "object"
        ? JSON.stringify(output.data)
        : // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-conversion
          String(output.data);
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

  // Handle traceback — emit as a structured error so VS Code's built-in
  // notebook error renderer applies its red-bordered styling. We rewrite
  // each frame: cell-temp paths become `Cell cell-<N>, line <M>`, and real
  // file paths get an inline `<a href>` anchor so VS Code's webview
  // opener turns them into clickable links.
  if (output.mimetype === "application/vnd.marimo+traceback") {
    const text =
      typeof output.data === "object"
        ? JSON.stringify(output.data)
        : // oxlint-disable-next-line typescript-eslint/no-unnecessary-type-conversion
          String(output.data);
    if (!text) {
      return null;
    }
    const cellIdToIndex = notebook
      ? createCellIdToIndex(MarimoNotebookDocument.from(notebook))
      : undefined;
    return code.NotebookCellOutputItem.error(parseTraceback(text, cellIdToIndex));
  }

  // Handle marimo errors
  if (output.channel === "marimo-error" && Array.isArray(output.data)) {
    // Convert marimo errors to VSCode Error objects
    const cellIdMapper = notebook
      ? createCellIdMapper(MarimoNotebookDocument.from(notebook))
      : undefined;
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
