import { Effect, Option } from "effect";
import type * as vscode from "vscode";
import type { MarimoNotebookDocument, NotebookCellId } from "../schemas.ts";
import { VariablesService } from "../services/variables/VariablesService.ts";
import { getTopologicalCellIds } from "./getTopologicalCellIds.ts";

/**
 * Get raw notebook cells in topological order, based on variable dependencies.
 *
 * Cells with no dependencies or stableId are placed at the end.
 */
export function getTopologicalCells(
  doc: MarimoNotebookDocument,
): Effect.Effect<Array<vscode.NotebookCell>, never, VariablesService> {
  return Effect.gen(function* () {
    const variablesService = yield* VariablesService;

    const cells = doc.getCells();

    if (cells.length === 0) {
      // Don't need to do anything for no cells
      return [];
    }

    const variables = yield* variablesService.getVariables(doc.id);

    // No variables yet - fall back to document order
    if (Option.isNone(variables)) {
      return cells.map((cell) => cell.rawNotebookCell);
    }

    const cellMap = new Map<NotebookCellId, vscode.NotebookCell>();
    const cellsWithoutIds: Array<vscode.NotebookCell> = [];

    for (const cell of cells) {
      if (Option.isNone(cell.id)) {
        cellsWithoutIds.push(cell.rawNotebookCell);
      } else {
        cellMap.set(cell.id.value, cell.rawNotebookCell);
      }
    }

    const sortedIds = getTopologicalCellIds(
      [...cellMap.keys()],
      variables.value,
    );

    // biome-ignore lint/style/noNonNullAssertion: All cells added above
    const sortedCells = sortedIds.map((id) => cellMap.get(id)!);

    return [...sortedCells, ...cellsWithoutIds];
  });
}
