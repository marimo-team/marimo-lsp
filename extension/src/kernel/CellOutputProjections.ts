import { Context, Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  type NotebookCellId,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  CellOutputProjection,
  type KeyedCellOutput,
} from "./CellOutputProjection.ts";

/** Shares output identity state between replay and live execution. */
export class CellOutputProjections extends Context.Service<CellOutputProjections>()(
  "CellOutputProjections",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const notebooks = new WeakMap<
        vscode.NotebookDocument,
        Map<NotebookCellId, CellOutputProjection>
      >();

      const forCell = (
        notebook: vscode.NotebookDocument,
        cellId: NotebookCellId,
      ): CellOutputProjection => {
        let cells = notebooks.get(notebook);
        if (cells === undefined) {
          cells = new Map();
          notebooks.set(notebook, cells);
        }
        let projection = cells.get(cellId);
        if (projection === undefined) {
          projection = new CellOutputProjection();
          cells.set(cellId, projection);
        }
        return projection;
      };

      yield* code.workspace.notebookDocumentChanges.pipe(
        Stream.runForEach((event) =>
          Effect.sync(() => {
            const cells = notebooks.get(event.notebook);
            if (cells === undefined) return;
            const retained = new Set(
              event.contentChanges.flatMap((change) =>
                change.addedCells.flatMap((rawCell) => {
                  const cell = MarimoNotebookCell.from(rawCell);
                  return Option.isSome(cell.id) ? [cell.id.value] : [];
                }),
              ),
            );
            for (const change of event.contentChanges) {
              for (const rawCell of change.removedCells) {
                const cell = MarimoNotebookCell.from(rawCell);
                if (Option.isSome(cell.id) && !retained.has(cell.id.value)) {
                  cells.delete(cell.id.value);
                }
              }
            }
            if (cells.size === 0) notebooks.delete(event.notebook);
          }),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* code.workspace.notebookDocumentClosed.pipe(
        Stream.runForEach((notebook) =>
          Effect.sync(() => notebooks.delete(notebook)),
        ),
        Effect.forkScoped({ startImmediately: true }),
      );

      return {
        forCell,
        restore(
          notebook: vscode.NotebookDocument,
          cellId: NotebookCellId,
          displayed: ReadonlyArray<vscode.NotebookCellOutput>,
          keyed: ReadonlyArray<KeyedCellOutput>,
        ) {
          return forCell(notebook, cellId).restore(displayed, keyed);
        },
      } as const;
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
