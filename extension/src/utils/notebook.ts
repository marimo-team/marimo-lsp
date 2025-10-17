import type { Brand } from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import type { MarimoNotebookDocument } from "../services/types.ts";
import type { CellMessage } from "../types.ts";

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
): vscode.NotebookCell {
  const cell = notebook.getCells().find((c) => getNotebookCellId(c) === cellId);
  if (!cell) {
    const cellIds = notebook.getCells().map((c) => getNotebookCellId(c));
    assert(
      cell,
      `No cell id ${cellId} in notebook ${notebook.uri.toString()}. Available cells: ${cellIds.join(", ")}`,
    );
  }
  return cell;
}
