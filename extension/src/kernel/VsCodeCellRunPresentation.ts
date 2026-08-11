import { Cause, Context, Data, Effect, Layer } from "effect";
import type * as vscode from "vscode";

import { unreachable } from "../assert.ts";
import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  findNotebookCell,
  type MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import type { NotebookCellId } from "../schemas/MarimoNotebookDocument.ts";
import type { CellRuntimeState } from "../types.ts";
import { CellOutputProjection } from "./CellOutputProjection.ts";
import type {
  CellRunPresentation,
  CellRunPresentationAction,
  CellRunRef,
} from "./CellRuns.ts";
import {
  buildKeyedCellOutputs,
  cellTracebackFrame,
  diagnosticMessage,
} from "./VsCodeCellOutputs.ts";

interface CellRunController {
  readonly createNotebookCellExecution: (
    cell: MarimoNotebookCell,
  ) => vscode.NotebookCellExecution;
}

export interface VsCodeCellRunBinding {
  readonly notebook: MarimoNotebookDocument;
  readonly controller: CellRunController;
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

const resourceKey = (cell: CellRunRef): string =>
  JSON.stringify([cell.notebookId, cell.cellId]);

/**
 * VS Code Adapter for Cell Runs.
 *
 * This is the only Module that owns the token-like
 * `vscode.NotebookCellExecution` returned by VS Code. A bound presentation
 * closes over the selected controller, while live run resources remain
 * private here and are addressed by domain cell identity.
 */
export class VsCodeCellRunPresentation extends Context.Service<VsCodeCellRunPresentation>()(
  "VsCodeCellRunPresentation",
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
        cell: CellRunRef,
        apply: (resource: PresentedRun) => Effect.Effect<void>,
      ) => {
        const resource = resources.get(resourceKey(cell));
        return resource === undefined
          ? Effect.logDebug("No live presentation for cell run").pipe(
              Effect.annotateLogs({ ...cell }),
            )
          : apply(resource);
      };

      const resolveCell = (cell: CellRunRef, binding: VsCodeCellRunBinding) =>
        Effect.gen(function* () {
          const notebook = binding.notebook;
          if (notebook.id !== cell.notebookId) {
            return yield* new InvalidCellError({
              cellId: cell.cellId,
              cause: new Error(
                "Cell run presentation bound to another notebook",
              ),
            });
          }
          return yield* findNotebookCell(notebook, cell.cellId);
        });

      const emitOutputs = (
        cell: CellRunRef,
        state: CellRuntimeState,
        final: boolean,
      ) =>
        withResource(cell, ({ notebook, projection }) => {
          const keyed = buildKeyedCellOutputs(
            cell.cellId,
            state,
            code,
            notebook,
          );
          return Effect.tryPromise(() =>
            final ? projection.commit(keyed) : projection.project(keyed),
          ).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("Failed to update cell output").pipe(
                Effect.annotateLogs({ cause, ...cell }),
              ),
            ),
          );
        });

      const clearRuntimeError = (
        cell: CellRunRef,
        binding: VsCodeCellRunBinding,
      ) =>
        resolveCell(cell, binding).pipe(
          Effect.flatMap((notebookCell) =>
            Effect.sync(() =>
              errorDiagnostics.delete(notebookCell.document.uri),
            ),
          ),
        );

      const applyRuntimeError = (
        cell: CellRunRef,
        binding: VsCodeCellRunBinding,
        state: CellRuntimeState,
      ) =>
        resolveCell(cell, binding).pipe(
          Effect.flatMap((notebookCell) =>
            Effect.sync(() => {
              const { document } = notebookCell;
              const frame =
                state.output?.channel === "marimo-error"
                  ? cellTracebackFrame(state, cell.cellId)
                  : undefined;
              if (frame === undefined) {
                errorDiagnostics.delete(document.uri);
                return;
              }
              const lineIndex = Math.min(
                Math.max(frame.line - 1, 0),
                Math.max(document.lineCount - 1, 0),
              );
              const diagnostic = new code.Diagnostic(
                document.lineAt(lineIndex).range,
                diagnosticMessage(state),
                code.DiagnosticSeverity.Error,
              );
              diagnostic.source = "marimo";
              errorDiagnostics.set(document.uri, [diagnostic]);
            }),
          ),
        );

      const apply = (
        cell: CellRunRef,
        binding: VsCodeCellRunBinding,
        action: CellRunPresentationAction,
      ) => {
        const effect = (() => {
          switch (action._tag) {
            case "CreateExecution":
              return Effect.gen(function* () {
                const notebookCell = yield* resolveCell(cell, binding);
                const execution = yield* Effect.try({
                  try: () =>
                    binding.controller.createNotebookCellExecution(
                      notebookCell,
                    ),
                  catch: (cause) =>
                    new InvalidCellError({ cellId: cell.cellId, cause }),
                });
                resources.set(resourceKey(cell), {
                  execution,
                  projection: new CellOutputProjection(execution),
                  notebook: binding.notebook.rawNotebookDocument,
                });
              });
            case "StartExecution":
              return withResource(cell, ({ execution }) =>
                Effect.sync(() => execution.start(action.startTime)),
              );
            case "EmitOutputs":
              return emitOutputs(cell, action.state, false);
            case "FinalizeOutputs":
              return emitOutputs(cell, action.state, true);
            case "EndExecution":
              return withResource(cell, ({ execution }) =>
                Effect.gen(function* () {
                  yield* Effect.try(() =>
                    execution.end(action.success, action.endTime),
                  ).pipe(Effect.ignore);
                  resources.delete(resourceKey(cell));
                }),
              );
            case "ApplyRuntimeError":
              return applyRuntimeError(cell, binding, action.state);
            case "ClearRuntimeError":
              return clearRuntimeError(cell, binding);
            default:
              return unreachable(action);
          }
        })();

        return effect.pipe(
          Effect.catchTag("NotebookCellNotFoundError", () =>
            Effect.logWarning("Notebook cell not found for presentation").pipe(
              Effect.annotateLogs({ ...cell }),
            ),
          ),
          Effect.catchTag("InvalidCellError", (error) =>
            Effect.logWarning(
              "Cell is no longer valid, skipping presentation",
            ).pipe(
              Effect.annotateLogs({
                cause: Cause.fail(error.cause),
                ...cell,
              }),
            ),
          ),
        );
      };

      return {
        bind: (binding: VsCodeCellRunBinding): CellRunPresentation => ({
          apply: (cell, action) => apply(cell, binding, action),
        }),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
