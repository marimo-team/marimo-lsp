import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import type {
  CellOutput,
  OutputMessage,
} from "@marimo-team/frontend/unstable_internal/core/kernel/messages.ts";
import {
  Cause,
  Context,
  Data,
  Effect,
  Equal,
  Layer,
  MutableHashMap,
  Option,
  Stream,
  SubscriptionRef,
  Array as EffectArray,
} from "effect";
import { constVoid } from "effect/Function";
import type * as vscode from "vscode";

import { assert, logUnreachable } from "../assert.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { prettyErrorMessage } from "../lib/errors.ts";
import {
  extractCellFrames,
  parseTraceback,
  type TracebackCellFrame,
} from "../lib/tracebacks.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  findNotebookCell,
  type MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  extractCellIdFromCellMessage,
  type NotebookCellId,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  type CellOperationNotification,
  type CellRuntimeState,
  createCellNavigationLink,
} from "../types.ts";
import {
  CellOutputProjection,
  type KeyedCellOutput,
} from "./CellOutputProjection.ts";
import {
  AcceptedSource,
  CellCommand,
  type CellRunEntry,
  makeCellRunEntry,
  Op,
  parseOp,
  RunId,
  step,
  transitionCell,
} from "./CellRunReducer.ts";

/**
 * The VS Code API service shape. A `Context.Service` class is the context
 * key. Use `Context.Service.Shape` to get the type of the service value.
 */
type VsCodeService = Context.Service.Shape<typeof VsCode>;

interface CellExecutionController {
  readonly createNotebookCellExecution: (
    cell: MarimoNotebookCell,
  ) => vscode.NotebookCellExecution;
}

/**
 * Thrown when VS Code's `createNotebookCellExecution` fails because the cell
 * is no longer part of the notebook (e.g., deleted between the time we looked
 * it up and the time we tried to create an execution for it).
 */
class InvalidCellError extends Data.TaggedError("InvalidCellError")<{
  readonly cellId: NotebookCellId;
  readonly cause: unknown;
}> {}

/** A run's live VS Code execution and the projection driving its outputs. */
interface RunResource {
  readonly runId: RunId;
  readonly execution: vscode.NotebookCellExecution;
  readonly projection: CellOutputProjection;
}

interface CellExecutionKey {
  readonly notebookId: NotebookId;
  readonly cellId: NotebookCellId;
}

// A plain object is sufficient. HashMap compares plain objects by structure.
const cellExecutionKey = (
  notebookId: NotebookId,
  cellId: NotebookCellId,
): CellExecutionKey => ({ notebookId, cellId });

/**
 * Everything the registry tracks for one cell: the pure {@link CellRunEntry},
 * the editor it belongs to (for interrupt fan-out), and its live execution
 * while a run is in flight.
 */
interface RunRecord {
  readonly entry: CellRunEntry;
  readonly editor: vscode.NotebookEditor | undefined;
  readonly resource: Option.Option<RunResource>;
}

/**
 * What the {@link CellCommand} interpreter needs to drive a single command.
 * `notebookCell` / `controller` are absent for interrupts (which only end
 * runs); commands that require them assert their presence.
 */
interface PerformContext {
  readonly key: CellExecutionKey;
  readonly cellId: NotebookCellId;
  readonly notebookCell: MarimoNotebookCell | undefined;
  readonly controller: CellExecutionController | undefined;
  readonly notebook: vscode.NotebookDocument | undefined;
}

/**
 * Owns the state and VS Code resources for cell executions.
 *
 * Cell operations update the run state, diagnostics, and projected output for
 * one cell. The same execution record tracks the code last accepted by the
 * kernel, which is used to derive whether the cell is stale. Interrupts end
 * every active execution for an editor.
 */
export class CellExecutions extends Context.Service<CellExecutions>()(
  "CellExecutions",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      // MutableHashMap hashes and compares only the keys. HashMap.set also
      // compares the old value and the new value when the key exists. That
      // walks the RunRecord by structure. The RunRecord holds a live
      // vscode.NotebookCellExecution. It is not safe to hash its getters.
      const records = MutableHashMap.empty<CellExecutionKey, RunRecord>();
      const revision = yield* SubscriptionRef.make(0);

      const emptyRecord = (
        cellId: NotebookCellId,
        editor?: vscode.NotebookEditor,
      ): RunRecord => ({
        entry: makeCellRunEntry(cellId),
        editor,
        resource: Option.none(),
      });

      const isCellStale = (cell: MarimoNotebookCell) => {
        const cellId = cell.id;
        if (Option.isNone(cellId)) {
          return Effect.succeed(false);
        }
        const notebookId = cell.notebook.id;
        const currentCode = cell.document.getText();

        return Effect.sync(() =>
          Option.match(
            MutableHashMap.get(
              records,
              cellExecutionKey(notebookId, cellId.value),
            ),
            {
              onNone: () => false,
              onSome: ({ entry }) =>
                AcceptedSource.$match(entry.acceptedSource, {
                  Unknown: () => false,
                  Invalidated: () => true,
                  Accepted: ({ source }) => source !== currentCode,
                }),
            },
          ),
        );
      };

      const updateStaleContext = Effect.fn(function* () {
        const activeNotebook = yield* editorRegistry.getActiveNotebookUri;
        const hasStaleCells = yield* Option.match(activeNotebook, {
          onNone: () => Effect.succeed(false),
          onSome: (notebookId) =>
            Effect.gen(function* () {
              const editor =
                yield* editorRegistry.getLastNotebookEditor(notebookId);
              if (Option.isNone(editor)) return false;
              const notebook = MarimoNotebookDocument.tryFrom(
                editor.value.notebook,
              );
              if (Option.isNone(notebook)) return false;
              for (const cell of notebook.value.getCells()) {
                if (yield* isCellStale(cell)) return true;
              }
              return false;
            }),
        });

        yield* code.commands.setContext(
          "marimo.notebook.hasStaleCells",
          hasStaleCells,
        );
      });

      const contentChanges = code.workspace.notebookDocumentChanges.pipe(
        Stream.filter((event) => {
          if (Option.isNone(MarimoNotebookDocument.tryFrom(event.notebook))) {
            return false;
          }
          return event.cellChanges.some(
            (change) => change.document !== undefined,
          );
        }),
      );

      yield* Effect.forkScoped(
        SubscriptionRef.changes(revision).pipe(
          Stream.runForEach(updateStaleContext),
        ),
      );
      yield* Effect.forkScoped(
        editorRegistry.streamActiveNotebookChanges.pipe(
          Stream.runForEach(updateStaleContext),
        ),
      );
      yield* Effect.forkScoped(
        contentChanges.pipe(
          Stream.mapEffect(updateStaleContext),
          Stream.runDrain,
        ),
      );

      const updateAcceptedSource = (
        cell: MarimoNotebookCell,
        acceptedSource: AcceptedSource,
      ) => {
        const cellId = cell.id;
        if (Option.isNone(cellId)) return Effect.void;
        const key = cellExecutionKey(cell.notebook.id, cellId.value);
        return Effect.sync(() => {
          const record = Option.getOrElse(
            MutableHashMap.get(records, key),
            () => emptyRecord(cellId.value),
          );
          if (Equal.equals(record.entry.acceptedSource, acceptedSource)) {
            return false;
          }
          MutableHashMap.set(records, key, {
            ...record,
            entry: { ...record.entry, acceptedSource },
          });
          return true;
        }).pipe(
          Effect.flatMap((changed) =>
            changed
              ? SubscriptionRef.update(revision, (value) => value + 1)
              : Effect.void,
          ),
        );
      };

      const recordExecution = (cell: MarimoNotebookCell) =>
        updateAcceptedSource(
          cell,
          AcceptedSource.Accepted({ source: cell.document.getText() }),
        );

      const invalidateCell = (cell: MarimoNotebookCell) =>
        updateAcceptedSource(cell, AcceptedSource.Invalidated());

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          MutableHashMap.forEach(records, (record) => {
            if (Option.isSome(record.resource)) {
              // Ensure all in-flight executions are ended on shutdown. `end`
              // throws if one was already ended (a benign race); swallow it so
              // disposal still completes.
              try {
                record.resource.value.execution.end(false);
              } catch {
                // already ended
              }
            }
          });
          MutableHashMap.clear(records);
        }),
      );

      // Runtime-error diagnostics: a red squiggle on the cell line that
      // raised, mirroring Jupyter. Kept in its own collection (separate from
      // the LSP server's static diagnostics) so the two don't clobber each
      // other; cleared when the cell re-runs.
      const errorDiagnostics = yield* acquireDisposable(() =>
        code.languages.createDiagnosticCollection("marimo-runtime"),
      );

      const clearErrorDiagnostic = (uri: vscode.Uri) =>
        Effect.sync(() => errorDiagnostics.delete(uri));

      const applyErrorDiagnostic = (
        notebookCell: MarimoNotebookCell,
        cellId: NotebookCellId,
        state: CellRuntimeState,
      ) =>
        Effect.sync(() => {
          const { document } = notebookCell;
          const frame =
            state.output?.channel === "marimo-error"
              ? cellTracebackFrame(state, cellId)
              : undefined;
          if (frame === undefined) {
            // Not an error (or no in-cell frame to point at, e.g. a syntax
            // error already covered by the language server) — drop any stale
            // squiggle.
            errorDiagnostics.delete(document.uri);
            return;
          }
          const lineIdx = Math.min(
            Math.max(frame.line - 1, 0),
            Math.max(document.lineCount - 1, 0),
          );
          const diagnostic = new code.Diagnostic(
            document.lineAt(lineIdx).range,
            diagnosticMessage(state),
            code.DiagnosticSeverity.Error,
          );
          diagnostic.source = "marimo";
          errorDiagnostics.set(document.uri, [diagnostic]);
        });

      const setResource = (
        key: CellExecutionKey,
        resource: Option.Option<RunResource>,
      ) =>
        Effect.sync(() => {
          MutableHashMap.modify(records, key, (record) => ({
            ...record,
            resource,
          }));
        });

      const getResource = (key: CellExecutionKey) =>
        Effect.sync(() =>
          MutableHashMap.get(records, key).pipe(
            Option.flatMap((record) => record.resource),
          ),
        );

      // Run `f` against the cell's live execution, or log+skip when there is
      // none (a benign race: the execution was ended concurrently).
      const withResource = (
        key: CellExecutionKey,
        runId: RunId,
        f: (resource: RunResource) => Effect.Effect<void>,
      ) =>
        getResource(key).pipe(
          Effect.map(Option.filter((resource) => resource.runId === runId)),
          Effect.flatMap(
            Option.match({
              onSome: f,
              onNone: () =>
                Effect.logDebug(
                  "No live execution for cell run; skipping command",
                ).pipe(
                  Effect.annotateLogs({
                    notebookId: key.notebookId,
                    cellId: key.cellId,
                    runId,
                  }),
                ),
            }),
          ),
        );

      const emitOutputs = (
        ctx: PerformContext,
        runId: RunId,
        state: CellRuntimeState,
        final: boolean,
      ) =>
        withResource(ctx.key, runId, ({ projection }) => {
          const keyed = buildKeyedCellOutputs(
            ctx.cellId,
            state,
            code,
            ctx.notebook,
          );
          return Effect.tryPromise(() =>
            final ? projection.commit(keyed) : projection.project(keyed),
          ).pipe(
            // A concurrent op may have ended the execution; not actionable.
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to update cell output").pipe(
                Effect.annotateLogs({ cause, cellId: ctx.cellId }),
              ),
            ),
          );
        });

      // The operation interpreter: drive one command against the real world.
      const drive = (command: CellCommand, ctx: PerformContext) =>
        CellCommand.$match(command, {
          OpenRun: ({ runId }) =>
            Effect.gen(function* () {
              assert(
                ctx.notebookCell !== undefined && ctx.controller !== undefined,
                "OpenRun requires a notebook cell and controller",
              );
              const notebookCell = ctx.notebookCell;
              const controller = ctx.controller;
              const execution = yield* Effect.try({
                try: () => controller.createNotebookCellExecution(notebookCell),
                catch: (cause) =>
                  new InvalidCellError({ cellId: ctx.cellId, cause }),
              });
              yield* setResource(
                ctx.key,
                Option.some({
                  runId,
                  execution,
                  projection: new CellOutputProjection(execution),
                }),
              );
            }),
          StartRun: ({ runId, at }) =>
            withResource(ctx.key, runId, ({ execution }) =>
              Effect.sync(() => execution.start(at)),
            ),
          RenderOutputs: ({ runId, state, final }) =>
            emitOutputs(ctx, runId, state, final),
          CloseRun: ({ runId, success, at }) =>
            withResource(ctx.key, runId, ({ execution }) =>
              Effect.gen(function* () {
                // `end` throws if already ended (a race); swallow it.
                yield* Effect.try(() => execution.end(success, at)).pipe(
                  Effect.ignore,
                );
                yield* setResource(ctx.key, Option.none());
              }),
            ),
          SetDiagnostic: ({ state }) => {
            assert(
              ctx.notebookCell !== undefined,
              "SetDiagnostic requires a notebook cell",
            );
            const notebookCell = ctx.notebookCell;
            return Option.match(state, {
              onNone: () => clearErrorDiagnostic(notebookCell.document.uri),
              onSome: (runtime) =>
                applyErrorDiagnostic(notebookCell, ctx.cellId, runtime),
            });
          },
        });

      return {
        isCellStale,
        recordExecution,
        invalidateCell,
        forgetCell(notebookId: NotebookId, cellId: NotebookCellId) {
          const key = cellExecutionKey(notebookId, cellId);
          return Effect.sync(() => {
            const record = MutableHashMap.get(records, key);
            if (Option.isNone(record)) return false;
            MutableHashMap.set(records, key, {
              ...record.value,
              entry: {
                ...record.value.entry,
                acceptedSource: AcceptedSource.Unknown(),
              },
            });
            return true;
          }).pipe(
            Effect.flatMap((changed) =>
              changed
                ? SubscriptionRef.update(revision, (value) => value + 1)
                : Effect.void,
            ),
          );
        },
        get changes(): Stream.Stream<void> {
          return Stream.merge(
            Stream.map(SubscriptionRef.changes(revision), constVoid),
            Stream.map(contentChanges, constVoid),
          );
        },
        handleInterrupt: (editor: vscode.NotebookEditor) =>
          Effect.gen(function* () {
            const targets = EffectArray.fromIterable(records).filter(
              ([, record]) => record.editor === editor,
            );
            for (const [key, record] of targets) {
              const { entry, commands } = step(record.entry, Op.Interrupt());
              yield* Effect.sync(() =>
                MutableHashMap.set(records, key, { ...record, entry }),
              );
              const ctx: PerformContext = {
                key,
                cellId: key.cellId,
                notebookCell: undefined,
                controller: undefined,
                notebook: undefined,
              };
              for (const command of commands) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- ordered
                yield* drive(command, ctx);
              }
            }
          }),
        handleOperation: (
          msg: CellOperationNotification,
          options: {
            editor: vscode.NotebookEditor;
            controller: CellExecutionController;
            renderOutput?: boolean;
          },
        ) =>
          Effect.gen(function* () {
            const { editor, controller } = options;
            const cellId = extractCellIdFromCellMessage(msg);
            const notebook = MarimoNotebookDocument.from(editor.notebook);
            const key = cellExecutionKey(notebook.id, cellId);

            const record = Option.getOrElse(
              MutableHashMap.get(records, key),
              () => emptyRecord(cellId, editor),
            );

            const notebookCell = yield* findNotebookCell(notebook, cellId);

            // Fold the cell-op into the run state once, up front, so the folded
            // state is persisted even for an op we end up dropping.
            const next = transitionCell(record.entry.state, msg);
            const op = parseOp(next, msg, RunId(crypto.randomUUID()));
            if (Option.isNone(op)) {
              yield* Effect.logWarning(
                "Queued cell-op missing run_id; cannot track execution",
              ).pipe(Effect.annotateLogs({ cellId, status: msg.status }));
              yield* Effect.sync(() =>
                MutableHashMap.set(records, key, {
                  ...record,
                  editor,
                  entry: { ...record.entry, state: next },
                }),
              );
              return;
            }

            const result = step(
              record.entry,
              op.value,
              notebookCell.document.getText(),
            );
            yield* Effect.sync(() =>
              MutableHashMap.set(records, key, {
                ...record,
                editor,
                entry: result.entry,
              }),
            );
            if (
              !Equal.equals(
                result.entry.acceptedSource,
                record.entry.acceptedSource,
              )
            ) {
              yield* SubscriptionRef.update(revision, (value) => value + 1);
            }

            const ctx: PerformContext = {
              key,
              cellId,
              notebookCell,
              controller,
              notebook: editor.notebook,
            };
            for (const command of result.commands) {
              if (
                options.renderOutput === false &&
                command._tag === "RenderOutputs"
              ) {
                continue;
              }
              // oxlint-disable-next-line eslint/no-await-in-loop -- commands
              // are ordered (e.g. RenderOutputs lands before CloseRun)
              yield* drive(command, ctx);
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
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([NotebookEditorRegistry.layer]),
  );
}

/**
 * Convert CellOperationNotification(s) to VSCode NotebookCellOutput.
 *
 * Returns None if no outputs, Some if there are outputs.
 */
export function scratchCellNotificationsToVsCodeOutput(
  notifications:
    | CellOperationNotification
    | ReadonlyArray<CellOperationNotification>,
  code: VsCodeService,
) {
  const arr = EffectArray.ensure(notifications);
  const outputs = buildCellOutputs(
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
  code: VsCodeService,
  notebook?: vscode.NotebookDocument,
): vscode.NotebookCellOutput[] {
  return buildKeyedCellOutputs(cellId, state, code, notebook).map(
    (keyed) => keyed.output,
  );
}

/**
 * Like {@link buildCellOutputs}, but each output carries a stable {@link
 * KeyedCellOutput.key}.
 *
 * Outputs are emitted in **arrival order** — console streams (`stdout`,
 * `stderr`) first, then the cell's result / error / traceback — mirroring
 * Jupyter rather than marimo's historical result-first layout. Combined with
 * the append-based reconcile in {@link CellOutputProjection}, this means each
 * slot is created once, in the order it first appears, and tall built-in
 * outputs (a traceback) are measured once instead of on every cell-op.
 */
function buildKeyedCellOutputs(
  cellId: NotebookCellId,
  state: CellRuntimeState,
  code: VsCodeService,
  notebook?: vscode.NotebookDocument,
): KeyedCellOutput[] {
  const outputs: KeyedCellOutput[] = [];

  // Collect items by channel
  const stdoutItems: vscode.NotebookCellOutputItem[] = [];
  const stderrItems: vscode.NotebookCellOutputItem[] = [];
  const stdinItems: vscode.NotebookCellOutputItem[] = [];
  const errorItems: vscode.NotebookCellOutputItem[] = [];
  const outputItems: vscode.NotebookCellOutputItem[] = [];
  // Tracebacks share the stderr channel with plain log text but must stay in
  // their own NotebookCellOutput: VS Code reads the items of one output as
  // alternative MIME representations of a single value and renders only one.
  const tracebackItems: vscode.NotebookCellOutputItem[] = [];

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

      if (output.mimetype === TRACEBACK_MIME) {
        tracebackItems.push(item);
        continue;
      }

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

  // Create keyed NotebookCellOutputs in arrival order: console streams first,
  // then the cell's result / error / traceback. Each `key` is the logical slot
  // the output reconciler tracks across cell-ops, so it must be stable for a
  // given channel within a run.
  if (stdoutItems.length > 0) {
    outputs.push({
      key: "stdout",
      output: new code.NotebookCellOutput(stdoutItems, { channel: "stdout" }),
    });
  }

  if (stderrItems.length > 0) {
    outputs.push({
      key: "stderr",
      output: new code.NotebookCellOutput(stderrItems, { channel: "stderr" }),
    });
  }

  // Result, error, and (when the error is redundant with a traceback) the
  // traceback all share one stable `"main"` key, so "error box, then traceback
  // supersedes it" is an in-place swap rather than a remove+append. The
  // marimo-error item is dropped when a traceback is present — the traceback
  // already renders `<Type>: <message>` as its header.
  const errorShown = errorItems.length > 0 && !shouldSuppressMarimoError(state);
  let mainSlotTaken = false;
  if (errorShown) {
    outputs.push({
      key: "main",
      output: new code.NotebookCellOutput(errorItems, {
        channel: "marimo-error",
      }),
    });
    mainSlotTaken = true;
  } else if (outputItems.length > 0) {
    outputs.push({
      key: "main",
      output: new code.NotebookCellOutput(outputItems),
    });
    mainSlotTaken = true;
  }

  tracebackItems.forEach((tracebackItem, index) => {
    // The first traceback claims the `"main"` slot when nothing else does (the
    // suppressed-error case), so an error box already shown there is swapped to
    // the traceback in place rather than removed.
    const key = !mainSlotTaken && index === 0 ? "main" : `traceback:${index}`;
    if (key === "main") mainSlotTaken = true;
    outputs.push({
      key,
      output: new code.NotebookCellOutput([tracebackItem], {
        channel: "stderr",
      }),
    });
  });

  if (stdinItems.length > 0) {
    outputs.push({
      key: "stdin",
      output: new code.NotebookCellOutput(stdinItems, { channel: "stdin" }),
    });
  }

  return outputs;
}

const TRACEBACK_MIME = "application/vnd.marimo+traceback";

function hasTraceback(state: CellRuntimeState): boolean {
  if (state.output?.mimetype === TRACEBACK_MIME) return true;
  return (state.consoleOutputs ?? []).some(
    (o) => o?.mimetype === TRACEBACK_MIME,
  );
}

/**
 * Innermost traceback frame inside `cellId` — i.e. the line in this cell where
 * the exception surfaced. Returns undefined when the cell has no traceback
 * (e.g. a structural marimo error) or the exception was raised entirely in
 * library/other-cell code, in which case there's no line here to underline.
 */
function cellTracebackFrame(
  state: CellRuntimeState,
  cellId: NotebookCellId,
): TracebackCellFrame | undefined {
  const traceback = (state.consoleOutputs ?? []).find(
    (o) => o?.mimetype === TRACEBACK_MIME,
  );
  if (!traceback) return undefined;
  const text =
    typeof traceback.data === "object"
      ? JSON.stringify(traceback.data)
      : traceback.data;
  return extractCellFrames(text)
    .filter((frame) => frame.cellId === cellId)
    .at(-1);
}

/** Human-readable message for the runtime-error diagnostic. */
function diagnosticMessage(state: CellRuntimeState): string {
  const data = state.output?.data;
  if (Array.isArray(data) && data.length > 0) {
    return prettyErrorMessage(data[0]);
  }
  return "Cell execution failed";
}

// Only suppress when every item is a plain `exception` without `raising_cell`:
// `strict-exception` carries `ref` and `blamed_cell`, and `exception` with
// `raising_cell` carries the "raised in cell" pointer — neither appears in the
// Python traceback, so the marimo-error block stays in those cases.
function shouldSuppressMarimoError(state: CellRuntimeState): boolean {
  const out = state.output;
  if (!out || out.channel !== "marimo-error" || !Array.isArray(out.data)) {
    return false;
  }
  const everyRedundant = out.data.every((e) => {
    if (e == null || typeof e !== "object") return false;
    if (!("type" in e) || e.type !== "exception") return false;
    return !("raising_cell" in e) || !e.raising_cell;
  });
  return everyRedundant && hasTraceback(state);
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

/**
 * Builds a single NotebookCellOutputItem from a CellOutput
 */
function buildOutputItem(
  output: CellOutput,
  cellId: NotebookCellId,
  state: CellRuntimeState,
  code: VsCodeService,
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
    return code.NotebookCellOutputItem.error(
      parseTraceback(text, cellIdToIndex),
    );
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
