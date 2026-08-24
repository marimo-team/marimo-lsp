import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Cause, Context, Data, Effect, Exit, Layer, Option } from "effect";
import type * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  findNotebookCell,
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOperationNotification, CellRuntimeState } from "../types.ts";
import { CellOutputProjection } from "./CellOutputProjection.ts";
import { CellCommand, type RunId } from "./CellRunReducer.ts";
import { transitionCell } from "./CellRunReducer.ts";
import type { CellRef } from "./DocumentExecutionSession.ts";
import type { NotebookCellPresentation } from "./NotebookCellPresentation.ts";
import {
  buildCellOutputs,
  buildKeyedCellOutputs,
  cellTracebackFrame,
  diagnosticMessage,
} from "./VsCodeCellOutputs.ts";

interface CellController {
  readonly createNotebookCellExecution: (
    cell: MarimoNotebookCell,
  ) => vscode.NotebookCellExecution;
}

export interface VsCodePresentationBinding {
  readonly notebook: MarimoNotebookDocument;
  readonly controller: CellController;
}

class InvalidCellError extends Data.TaggedError("InvalidCellError")<{
  readonly cellId: NotebookCellId;
  readonly cause: unknown;
}> {}

interface PresentedRun {
  readonly execution: vscode.NotebookCellExecution;
  readonly projection: CellOutputProjection;
  readonly notebook: vscode.NotebookDocument;
  started: boolean;
}

const resourceKey = (cell: CellRef, runId: RunId): string =>
  JSON.stringify([cell.notebookId, cell.cellId, runId]);

/** Presents notebook cell state through VS Code's notebook execution API. */
export class VsCodeCellPresentation extends Context.Service<VsCodeCellPresentation>()(
  "VsCodeCellPresentation",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const resources = new Map<string, PresentedRun>();
      const errorDiagnostics = yield* acquireDisposable(() =>
        code.languages.createDiagnosticCollection("marimo-runtime"),
      );

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          for (const resource of resources.values()) {
            try {
              resource.execution.end(false);
            } catch {
              // The execution was already ended by a concurrent notification.
            }
          }
          resources.clear();
        }),
      );

      /** Applies a function while a cell run still has live resources. */
      const withResource = (
        cell: CellRef,
        runId: RunId,
        apply: (resource: PresentedRun) => Effect.Effect<void>,
      ) => {
        const resource = resources.get(resourceKey(cell, runId));
        return resource === undefined
          ? Effect.logDebug("No live VS Code execution for cell run").pipe(
              Effect.annotateLogs({ ...cell, runId }),
            )
          : apply(resource);
      };

      /** Resolves a cell within the notebook bound to this drive. */
      const resolveCell = (cell: CellRef, binding: VsCodePresentationBinding) =>
        Effect.gen(function* () {
          if (binding.notebook.id !== cell.notebookId) {
            return yield* new InvalidCellError({
              cellId: cell.cellId,
              cause: new Error("Presentation is bound to another notebook"),
            });
          }
          return yield* findNotebookCell(binding.notebook, cell.cellId);
        });

      /** Creates a VS Code execution for a resolved cell. */
      const createExecution = (
        cell: CellRef,
        binding: VsCodePresentationBinding,
      ) =>
        Effect.gen(function* () {
          const notebookCell = yield* resolveCell(cell, binding);
          return yield* Effect.try({
            try: () =>
              binding.controller.createNotebookCellExecution(notebookCell),
            catch: (cause) =>
              new InvalidCellError({ cellId: cell.cellId, cause }),
          });
        });

      /** Projects state onto a tracked run's live execution. */
      const renderOutputs = (
        cell: CellRef,
        runId: RunId,
        state: CellRuntimeState,
        final: boolean,
      ) =>
        withResource(cell, runId, ({ notebook, projection, started }) => {
          if (!started) return Effect.void;
          const outputs = buildKeyedCellOutputs(
            cell.cellId,
            state,
            code,
            notebook,
          );
          return Effect.tryPromise(() =>
            final ? projection.commit(outputs) : projection.project(outputs),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to update cell output").pipe(
                Effect.annotateLogs({ cause, ...cell, runId }),
              ),
            ),
          );
        });

      /** Reconciles the runtime diagnostic for a cell. */
      const setDiagnostic = (
        cell: CellRef,
        binding: VsCodePresentationBinding,
        state: Option.Option<CellRuntimeState>,
      ) =>
        resolveCell(cell, binding).pipe(
          Effect.flatMap((notebookCell) =>
            Effect.sync(() => {
              const { document } = notebookCell;
              if (Option.isNone(state)) {
                errorDiagnostics.delete(document.uri);
                return;
              }
              const frame =
                state.value.output?.channel === "marimo-error"
                  ? cellTracebackFrame(state.value, cell.cellId)
                  : undefined;
              if (frame === undefined) {
                errorDiagnostics.delete(document.uri);
                return;
              }
              const line = Math.min(
                Math.max(frame.line - 1, 0),
                Math.max(document.lineCount - 1, 0),
              );
              const diagnostic = new code.Diagnostic(
                document.lineAt(line).range,
                diagnosticMessage(state.value),
                code.DiagnosticSeverity.Error,
              );
              diagnostic.source = "marimo";
              errorDiagnostics.set(document.uri, [diagnostic]);
            }),
          ),
        );

      /** Presents an untracked error in one self-contained execution. */
      const presentUntrackedError = (
        cell: CellRef,
        binding: VsCodePresentationBinding,
        state: CellRuntimeState,
        applyDiagnostic: boolean,
      ) =>
        Effect.gen(function* () {
          const execution = yield* createExecution(cell, binding);
          return yield* Effect.gen(function* () {
            yield* Effect.sync(() => execution.start());
            const outputs = buildKeyedCellOutputs(
              cell.cellId,
              state,
              code,
              binding.notebook.rawNotebookDocument,
            );
            yield* Effect.tryPromise(() =>
              new CellOutputProjection(execution).commit(outputs),
            ).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to update cell output").pipe(
                  Effect.annotateLogs({ cause, ...cell }),
                ),
              ),
            );
            if (applyDiagnostic) {
              yield* setDiagnostic(cell, binding, Option.some(state));
            }
          }).pipe(
            Effect.ensuring(
              Effect.try(() => execution.end(false)).pipe(Effect.ignore),
            ),
          );
        });

      /** Interprets one reducer command against a VS Code binding. */
      const apply = (
        cell: CellRef,
        binding: VsCodePresentationBinding,
        command: CellCommand,
      ) =>
        CellCommand.$match(command, {
          OpenRun: ({ runId }) =>
            Effect.gen(function* () {
              const execution = yield* createExecution(cell, binding);
              resources.set(resourceKey(cell, runId), {
                execution,
                projection: new CellOutputProjection(execution),
                notebook: binding.notebook.rawNotebookDocument,
                started: false,
              });
            }),
          StartRun: ({ runId, at }) =>
            withResource(cell, runId, (resource) =>
              Effect.sync(() => {
                resource.execution.start(Option.getOrUndefined(at));
                resource.started = true;
              }),
            ),
          RenderOutputs: ({ runId, state, final }) =>
            renderOutputs(cell, runId, state, final),
          CloseRun: ({ runId, success, at }) =>
            withResource(cell, runId, ({ execution }) =>
              Effect.gen(function* () {
                yield* Effect.try(() =>
                  execution.end(success, Option.getOrUndefined(at)),
                ).pipe(Effect.ignore);
                resources.delete(resourceKey(cell, runId));
              }),
            ),
          PresentUntrackedError: ({ state, applyDiagnostic }) =>
            presentUntrackedError(cell, binding, state, applyDiagnostic),
          SetDiagnostic: ({ state }) => setDiagnostic(cell, binding, state),
        }).pipe(
          Effect.catchTag("NotebookCellNotFoundError", () =>
            Effect.logWarning("Notebook cell not found for command").pipe(
              Effect.annotateLogs({ ...cell, command: command._tag }),
            ),
          ),
          Effect.catchTag("InvalidCellError", (error) =>
            Effect.logWarning("Cell is no longer valid; skipping command").pipe(
              Effect.annotateLogs({
                cause: Cause.fail(error.cause),
                ...cell,
                command: command._tag,
              }),
            ),
          ),
        );

      const presentSavedOutputs = (
        binding: VsCodePresentationBinding,
        notifications: ReadonlyArray<CellOperationNotification>,
        notebookVersion: number,
        onPresented: (
          notification: CellOperationNotification,
        ) => Effect.Effect<void>,
      ) =>
        Effect.flatten(
          Effect.sync(() => {
            const document = binding.notebook.rawNotebookDocument;
            if (document.isClosed || document.version !== notebookVersion) {
              return Effect.void;
            }
            return Effect.forEach(
              notifications,
              (notification) => {
                const cellId = NotebookCellId(notification.cell_id);
                const resumeLiveRun =
                  notification.status === "queued" ||
                  notification.status === "running"
                    ? Effect.uninterruptible(onPresented(notification))
                    : Effect.void;
                return Effect.gen(function* () {
                  const document = binding.notebook.rawNotebookDocument;
                  if (document.isClosed) return;

                  const cell = yield* resolveCell(
                    { notebookId: binding.notebook.id, cellId },
                    binding,
                  );
                  if (cell.outputs.length > 0) {
                    yield* Effect.uninterruptible(onPresented(notification));
                    return;
                  }

                  const state = transitionCell(
                    createCellRuntimeState(),
                    notification,
                  );
                  const outputs = buildCellOutputs(
                    cellId,
                    state,
                    code,
                    document,
                  );
                  if (outputs.length === 0) {
                    yield* Effect.uninterruptible(onPresented(notification));
                    return;
                  }

                  yield* Effect.uninterruptibleMask((restore) =>
                    Effect.gen(function* () {
                      const exit = yield* Effect.acquireUseRelease(
                        Effect.try({
                          try: () =>
                            binding.controller.createNotebookCellExecution(
                              cell,
                            ),
                          catch: (cause) =>
                            new InvalidCellError({ cellId, cause }),
                        }),
                        (execution) =>
                          Effect.gen(function* () {
                            yield* Effect.try({
                              try: () => execution.start(),
                              catch: (cause) =>
                                new InvalidCellError({ cellId, cause }),
                            });
                            const replacement = yield* Effect.try({
                              try: () => execution.replaceOutput(outputs),
                              catch: (cause) =>
                                new InvalidCellError({ cellId, cause }),
                            });
                            return yield* restore(
                              Effect.tryPromise(() => replacement),
                            ).pipe(Effect.exit);
                          }),
                        (execution) =>
                          Effect.sync(() => {
                            try {
                              execution.end(undefined);
                            } catch {
                              // The controller or document changed during presentation.
                            }
                          }),
                      );

                      // replaceOutput is not cancellable. Once submitted, an
                      // interrupt cannot prove that VS Code did not apply it.
                      // End the synthetic execution before restoring a live run.
                      if (
                        Exit.isSuccess(exit) ||
                        (Exit.isFailure(exit) &&
                          Cause.hasInterrupts(exit.cause))
                      ) {
                        yield* onPresented(notification);
                      }
                      return yield* exit;
                    }),
                  );
                }).pipe(
                  Effect.catchTag("NotebookCellNotFoundError", () =>
                    Effect.logDebug(
                      "Saved output cell is no longer present",
                    ).pipe(
                      Effect.annotateLogs({
                        notebookId: binding.notebook.id,
                        cellId,
                      }),
                      Effect.andThen(resumeLiveRun),
                    ),
                  ),
                  Effect.catch((error) =>
                    Effect.logDebug("Failed to present saved cell output").pipe(
                      Effect.annotateLogs({
                        cause: Cause.fail(error),
                        notebookId: binding.notebook.id,
                        cellId,
                      }),
                      Effect.andThen(resumeLiveRun),
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.failCause(cause)
                      : Effect.logDebug(
                          "Failed to present saved cell output",
                        ).pipe(
                          Effect.annotateLogs({
                            cause,
                            notebookId: binding.notebook.id,
                            cellId,
                          }),
                          Effect.andThen(resumeLiveRun),
                        ),
                  ),
                );
              },
              { concurrency: 1, discard: true },
            );
          }),
        );

      return {
        bind(binding: VsCodePresentationBinding): NotebookCellPresentation {
          return {
            present: (cell, command) => apply(cell, binding, command),
            presentSavedOutputs: (
              notifications,
              notebookVersion,
              onPresented,
            ) =>
              presentSavedOutputs(
                binding,
                notifications,
                notebookVersion,
                onPresented,
              ),
          };
        },
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
