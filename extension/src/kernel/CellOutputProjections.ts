import { Context, Effect, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import * as VsCode from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  type NotebookCellId,
} from "../schemas/MarimoNotebookDocument.ts";
import {
  CellOutputProjection,
  type KeyedCellOutput,
} from "./CellOutputProjection.ts";

/** Shares output identity state between replay and live execution. */
export interface Interface {
  readonly forCell: (
    notebook: vscode.NotebookDocument,
    cellId: NotebookCellId,
  ) => CellOutputProjection;
  readonly restore: (
    notebook: vscode.NotebookDocument,
    cellId: NotebookCellId,
    displayed: ReadonlyArray<vscode.NotebookCellOutput>,
    keyed: ReadonlyArray<KeyedCellOutput>,
  ) => Effect.Effect<boolean>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/CellOutputProjections",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode.Service;
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

    const restore = Effect.fn("CellOutputProjections.restore")(function* (
      notebook: vscode.NotebookDocument,
      cellId: NotebookCellId,
      displayed: ReadonlyArray<vscode.NotebookCellOutput>,
      keyed: ReadonlyArray<KeyedCellOutput>,
    ) {
      return yield* forCell(notebook, cellId).restore(displayed, keyed);
    });

    return Service.of({ forCell, restore });
  }),
);
