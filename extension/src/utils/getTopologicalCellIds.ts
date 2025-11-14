import type { VariableName } from "../services/variables/VariablesService.ts";
import type { NotebookCellId } from "./notebook.ts";

/**
 * Get topologically sorted cell IDs based on variable dependencies.
 *
 * If cell A declares a variable used by cell B, then A appears before B in the result.
 * Cells with no dependencies are placed at the end.
 *
 * @param cellIds - Array of notebook cell IDs to sort.
 * @param variables - Mapping of variable names to their declaring and using cell IDs.
 * @returns Topologically sorted array of notebook cell IDs.
 */
export function getTopologicalCellIds(
  cellIds: ReadonlyArray<NotebookCellId>,
  variables: Array<{
    name: VariableName;
    declaredBy: ReadonlyArray<NotebookCellId>;
    usedBy: ReadonlyArray<NotebookCellId>;
  }>,
) {
  // Build adjacency list
  const adjacency = new Map<NotebookCellId, Array<NotebookCellId>>();
  for (const id of cellIds) {
    adjacency.set(id, []);
  }

  // Start with all cells with no declaredBy or usedBy
  const noDepCells = new Set<NotebookCellId>(cellIds); // Cells with no declaredBy
  const noUsedByCells = new Set<NotebookCellId>(cellIds); // Cells with no usedBy

  // Link "declaredBy -> usedBy"
  for (const { declaredBy, usedBy } of variables) {
    for (const declCell of declaredBy) {
      noDepCells.delete(declCell);
      for (const useCell of usedBy) {
        noUsedByCells.delete(useCell);

        if (useCell !== declCell) {
          adjacency.get(declCell)?.push(useCell);
        }
      }
    }
  }

  // Kahn's algorithm for topological sort
  const inDegree = new Map<NotebookCellId, number>();
  for (const id of cellIds) {
    inDegree.set(id, 0);
  }

  for (const targets of adjacency.values()) {
    for (const t of targets) {
      inDegree.set(t, (inDegree.get(t) || 0) + 1);
    }
  }

  const queue: Array<NotebookCellId> = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) {
      queue.push(id);
    }
  });

  const sorted: Array<NotebookCellId> = [];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) {
      break;
    }
    sorted.push(current);
    adjacency.get(current)?.forEach((t) => {
      inDegree.set(t, (inDegree.get(t) || 0) - 1);
      if (inDegree.get(t) === 0) {
        queue.push(t);
      }
    });
  }

  // Put noDepCells at the end
  const filteredSorted = sorted.filter((id) => !noDepCells.has(id));
  return [...filteredSorted, ...noDepCells];
}
