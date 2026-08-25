import { createCellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";
import { Context, Effect, Layer } from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../platform/VsCode.ts";
import {
  findNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId,
} from "../schemas/MarimoNotebookDocument.ts";
import type { CellOutputReplay } from "../schemas/Models.gen.ts";
import { transitionCell } from "./CellRunReducer.ts";
import { buildCellOutputs } from "./VsCodeCellOutputs.ts";

interface CellController {
  readonly createNotebookCellExecution: (
    cell: vscode.NotebookCell,
  ) => vscode.NotebookCellExecution;
}

/** Presents a SessionView snapshot without claiming a successful run. */
export class VsCodeNotebookOutputPresenter extends Context.Service<VsCodeNotebookOutputPresenter>()(
  "VsCodeNotebookOutputPresenter",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;

      const present = Effect.fn("VsCodeNotebookOutputPresenter.present")(
        function* (
          notebook: MarimoNotebookDocument,
          controller: CellController,
          replays: ReadonlyArray<CellOutputReplay>,
        ) {
          yield* Effect.forEach(
            replays,
            (replay) =>
              Effect.gen(function* () {
                const { notification } = replay;
                const cellId = NotebookCellId(notification.cell_id);
                const cell = yield* findNotebookCell(notebook, cellId);
                if (cell.outputs.length > 0) return;

                const state = transitionCell(
                  createCellRuntimeState(),
                  notification,
                );
                const outputs = buildCellOutputs(
                  cellId,
                  state,
                  code,
                  notebook.rawNotebookDocument,
                );
                if (outputs.length === 0) return;

                const execution = yield* Effect.try(() =>
                  controller.createNotebookCellExecution(cell.rawNotebookCell),
                );
                yield* Effect.acquireUseRelease(
                  Effect.succeed(execution),
                  (current) =>
                    Effect.sync(() => current.start(Date.now())).pipe(
                      Effect.andThen(
                        Effect.tryPromise(() => current.replaceOutput(outputs)),
                      ),
                    ),
                  (current) => Effect.sync(() => current.end(undefined)),
                );
              }).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("Failed to replay cell output").pipe(
                    Effect.annotateLogs({
                      cause,
                      cellId: replay.notification.cell_id,
                      notebookUri: notebook.id,
                    }),
                  ),
                ),
              ),
            { discard: true },
          );
        },
      );

      return { present };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
