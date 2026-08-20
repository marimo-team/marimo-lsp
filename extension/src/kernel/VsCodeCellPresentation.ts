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
import type { SavedCellOutput } from "../schemas/Models.gen.ts";
import type { CellRuntimeState } from "../types.ts";
import { CellOutputProjection } from "./CellOutputProjection.ts";
import { CellCommand, type RunId } from "./CellRunReducer.ts";
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

      const renderOutputs = (
        cell: CellRef,
        runId: RunId,
        state: CellRuntimeState,
        final: boolean,
      ) =>
        withResource(cell, runId, ({ notebook, projection }) => {
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
              });
            }),
          StartRun: ({ runId, at }) =>
            withResource(cell, runId, ({ execution }) =>
              Effect.sync(() => execution.start(Option.getOrUndefined(at))),
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
        outputs: ReadonlyArray<SavedCellOutput>,
        notebookVersion: number,
        onPresented: (cellId: NotebookCellId) => Effect.Effect<void>,
      ) =>
        Effect.flatten(
          Effect.sync(() => {
            const document = binding.notebook.rawNotebookDocument;
            if (document.isClosed || document.version !== notebookVersion) {
              return Effect.void;
            }

            return Effect.forEach(
              outputs,
              (saved) => {
                const cellId = NotebookCellId(saved.cellId);
                return Effect.gen(function* () {
                  // VS Code advances NotebookDocument.version for the transient
                  // output and execution-summary changes below. Provenance was
                  // checked before hydration; later source edits may retain this
                  // display because every restored output is explicitly stale.
                  if (document.isClosed) return;

                  const cell = yield* resolveCell(
                    { notebookId: binding.notebook.id, cellId },
                    binding,
                  );
                  if (cell.outputs.length > 0) return;

                  const state: CellRuntimeState = {
                    ...createCellRuntimeState(),
                    output: saved.output,
                    consoleOutputs: [...saved.console],
                    // marimo's cold edit-mode startup marks restored, unrun
                    // cells stale after replaying their saved display state.
                    staleInputs: true,
                  };
                  yield* Effect.acquireUseRelease(
                    Effect.try({
                      try: () =>
                        binding.controller.createNotebookCellExecution(cell),
                      catch: (cause) => new InvalidCellError({ cellId, cause }),
                    }),
                    (execution) =>
                      Effect.uninterruptibleMask((restore) =>
                        Effect.gen(function* () {
                          yield* Effect.try({
                            try: () => execution.start(),
                            catch: (cause) =>
                              new InvalidCellError({ cellId, cause }),
                          });
                          const replacement = yield* Effect.try({
                            try: () =>
                              execution.replaceOutput(
                                buildCellOutputs(cellId, state, code, document),
                              ),
                            catch: (cause) =>
                              new InvalidCellError({ cellId, cause }),
                          });
                          const exit = yield* restore(
                            Effect.tryPromise(() => replacement),
                          ).pipe(Effect.exit);

                          // replaceOutput is a non-cancellable host operation.
                          // Once submitted, cancellation cannot prove that VS
                          // Code did not apply it, so commit its stale marker
                          // before propagating the interrupt.
                          if (
                            Exit.isSuccess(exit) ||
                            (Exit.isFailure(exit) &&
                              Cause.hasInterrupts(exit.cause))
                          ) {
                            yield* onPresented(cellId);
                          }
                          return yield* exit;
                        }),
                      ),
                    (execution) =>
                      Effect.sync(() => {
                        try {
                          execution.end(undefined);
                        } catch {
                          // The controller or document changed during hydration.
                        }
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
                    ),
                  ),
                  Effect.catch((error) =>
                    Effect.logDebug("Failed to restore saved cell output").pipe(
                      Effect.annotateLogs({
                        cause: Cause.fail(error),
                        notebookId: binding.notebook.id,
                        cellId,
                      }),
                    ),
                  ),
                  Effect.catchCause((cause) =>
                    Cause.hasInterrupts(cause)
                      ? Effect.failCause(cause)
                      : Effect.logDebug(
                          "Failed to restore saved cell output",
                        ).pipe(
                          Effect.annotateLogs({
                            cause,
                            notebookId: binding.notebook.id,
                            cellId,
                          }),
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
            presentSavedOutputs: (outputs, notebookVersion, onPresented) =>
              presentSavedOutputs(
                binding,
                outputs,
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
