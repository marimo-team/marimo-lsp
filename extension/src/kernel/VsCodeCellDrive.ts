import { Cause, Context, Data, Effect, Layer, Option } from "effect";
import type * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  findNotebookCell,
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellRuntimeState } from "../types.ts";
import type { CellRef, Drive } from "./CellExecutions.ts";
import { CellOutputProjection } from "./CellOutputProjection.ts";
import { CellCommand, type RunId } from "./CellRunReducer.ts";
import {
  buildKeyedCellOutputs,
  cellTracebackFrame,
  diagnosticMessage,
} from "./VsCodeCellOutputs.ts";

interface CellController {
  readonly createNotebookCellExecution: (
    cell: MarimoNotebookCell,
  ) => vscode.NotebookCellExecution;
}

export interface VsCodeDriveBinding {
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

/** Owns VS Code's live execution handles behind the {@link Drive} seam. */
export class VsCodeCellDrive extends Context.Service<VsCodeCellDrive>()(
  "VsCodeCellDrive",
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
      const resolveCell = (cell: CellRef, binding: VsCodeDriveBinding) =>
        Effect.gen(function* () {
          if (binding.notebook.id !== cell.notebookId) {
            return yield* new InvalidCellError({
              cellId: cell.cellId,
              cause: new Error("Drive is bound to another notebook"),
            });
          }
          return yield* findNotebookCell(binding.notebook, cell.cellId);
        });

      /** Creates a VS Code execution for a resolved cell. */
      const createExecution = (cell: CellRef, binding: VsCodeDriveBinding) =>
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

      /** Reconciles the runtime diagnostic for a cell. */
      const setDiagnostic = (
        cell: CellRef,
        binding: VsCodeDriveBinding,
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
        binding: VsCodeDriveBinding,
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
        binding: VsCodeDriveBinding,
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

      return {
        bind:
          (binding: VsCodeDriveBinding): Drive =>
          (cell, command) =>
            apply(cell, binding, command),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
