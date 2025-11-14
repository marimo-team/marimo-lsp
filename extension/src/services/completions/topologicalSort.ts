import type { NotebookCellId } from "../../utils/notebook";

export interface Variables {
  [variableName: string]: {
    declaredBy: NotebookCellId[];
    usedBy: NotebookCellId[];
  };
}

export function getTopologicalCellIds(cellIds: NotebookCellId[], variables: Variables) {
  // Build adjacency list
  const adjacency = new Map<NotebookCellId, NotebookCellId[]>();
  cellIds.forEach((id) => adjacency.set(id, []));

  // Start with all cells with no declaredBy or usedBy
  const noDepCells = new Set<NotebookCellId>(cellIds); // Cells with no declaredBy
  const noUsedByCells = new Set<NotebookCellId>(cellIds); // Cells with no usedBy

  // Link "declaredBy -> usedBy"
  for (const { declaredBy, usedBy } of Object.values(variables)) {
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
  cellIds.forEach((id) => inDegree.set(id, 0));

  adjacency.forEach((targets) => {
    targets.forEach((t) => {
      inDegree.set(t, (inDegree.get(t) || 0) + 1);
    });
  });

  const queue: NotebookCellId[] = [];
  inDegree.forEach((deg, id) => {
    if (deg === 0) {
      queue.push(id);
    }
  });

  const sorted: NotebookCellId[] = [];
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
