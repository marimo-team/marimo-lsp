import { Brand, Data, Effect } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import type { MarimoNotebookDocument } from "../services/types.ts";
import type { CellMessage } from "../types.ts";

class NotebookCellNotFoundError extends Data.TaggedError(
  "NotebookCellNotFoundError",
)<{
  readonly cellId: NotebookCellId;
  readonly notebook: vscode.NotebookDocument;
}> {
  get message() {
    const cellIds = this.notebook.getCells().map((c) => getNotebookCellId(c));
    return `No cell id ${this.cellId} in notebook ${this.notebook.uri.toString()}. Available cells: ${cellIds.join(
      ", ",
    )}`;
  }
}

export function isMarimoNotebookDocument(
  notebook: vscode.NotebookDocument,
): notebook is MarimoNotebookDocument {
  return notebook.notebookType === NOTEBOOK_TYPE;
}

/**
 * Get the id of a notebook cell
 * @param cell - The notebook cell
 * @returns The id of the cell
 */

export function getNotebookCellId(
  cell: Pick<vscode.NotebookCell, "document">,
): NotebookCellId {
  return cell.document.uri.toString() as NotebookCellId;
}

export const NotebookCellId = Brand.nominal<NotebookCellId>();
export type NotebookCellId = Brand.Branded<string, "CellId">;
export function extractCellId(msg: CellMessage) {
  return msg.cell_id as NotebookCellId;
}

/**
 * Get a notebook cell by its id
 * @param notebook - The notebook document
 * @param cellId - The id of the cell
 * @returns The notebook cell
 * @throws An error if the cell is not found
 */
export function getNotebookCell(
  notebook: vscode.NotebookDocument,
  cellId: NotebookCellId,
) {
  return Effect.gen(function* () {
    const cell = notebook
      .getCells()
      .find((c) => getNotebookCellId(c) === cellId);
    if (!cell) {
      return yield* new NotebookCellNotFoundError({ cellId, notebook });
    }
    return cell;
  });
}
