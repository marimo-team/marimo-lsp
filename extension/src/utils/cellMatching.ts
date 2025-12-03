import { Option } from "effect";
import type { MarimoNotebookCell, NotebookCellId } from "../schemas.ts";

export interface CellMatchResult {
  /** Mapping from old cell stableId to new cell */
  matched: Map<NotebookCellId, MarimoNotebookCell>;
  /** Old cells with no match (truly deleted) */
  unmatched: Array<MarimoNotebookCell>;
  /** New cells with no match (truly added) */
  newCells: Array<MarimoNotebookCell>;
}

/**
 * Match removed cells to added cells to preserve stable IDs and outputs.
 *
 * Uses VS Code's notebook diff strategy:
 * 1. Find common prefix - cells that match from the beginning
 * 2. Find common suffix - cells that match from the end
 * 3. Middle section - match by position (content changed but same cell)
 *
 * This handles the common case of editing a cell's content while preserving
 * its identity, as well as insertions and deletions.
 */
export function matchCells(
  removedCells: Array<MarimoNotebookCell>,
  addedCells: Array<MarimoNotebookCell>,
): CellMatchResult {
  const matched = new Map<NotebookCellId, MarimoNotebookCell>();

  const oldLen = removedCells.length;
  const newLen = addedCells.length;

  // Find common prefix (matching cells from the start)
  const prefixLen = commonPrefix(removedCells, addedCells);

  // Match prefix cells
  for (let i = 0; i < prefixLen; i++) {
    const stableId = removedCells[i].maybeId;
    if (Option.isSome(stableId)) {
      matched.set(stableId.value, addedCells[i]);
    }
  }

  // Find common suffix (matching cells from the end)
  // Don't overlap with prefix
  const maxSuffix = Math.min(oldLen - prefixLen, newLen - prefixLen);
  const suffixLen = commonSuffix(
    removedCells,
    addedCells,
    prefixLen,
    maxSuffix,
  );

  // Match suffix cells
  for (let i = 0; i < suffixLen; i++) {
    const oldIdx = oldLen - 1 - i;
    const newIdx = newLen - 1 - i;
    const stableId = removedCells[oldIdx].maybeId;
    if (Option.isSome(stableId)) {
      matched.set(stableId.value, addedCells[newIdx]);
    }
  }

  // Middle section: cells between prefix and suffix
  const oldMiddleStart = prefixLen;
  const oldMiddleEnd = oldLen - suffixLen;
  const newMiddleStart = prefixLen;
  const newMiddleEnd = newLen - suffixLen;

  const oldMiddle = removedCells.slice(oldMiddleStart, oldMiddleEnd);
  const newMiddle = addedCells.slice(newMiddleStart, newMiddleEnd);

  // Match middle cells by position (edited cells)
  const middleMatchLen = Math.min(oldMiddle.length, newMiddle.length);
  for (let i = 0; i < middleMatchLen; i++) {
    const stableId = oldMiddle[i].maybeId;
    if (Option.isSome(stableId)) {
      matched.set(stableId.value, newMiddle[i]);
    }
  }

  // Unmatched old cells (truly deleted)
  const unmatched = oldMiddle.slice(middleMatchLen);

  // Unmatched new cells (truly added)
  const newCells = newMiddle.slice(middleMatchLen);

  return { matched, unmatched, newCells };
}

/**
 * Find number of matching cells from the beginning.
 */
function commonPrefix(
  oldCells: Array<MarimoNotebookCell>,
  newCells: Array<MarimoNotebookCell>,
): number {
  const maxLen = Math.min(oldCells.length, newCells.length);
  let result = 0;

  for (let i = 0; i < maxLen; i++) {
    if (cellsEqual(oldCells[i], newCells[i])) {
      result++;
    } else {
      break;
    }
  }

  return result;
}

/**
 * Find number of matching cells from the end.
 */
function commonSuffix(
  oldCells: Array<MarimoNotebookCell>,
  newCells: Array<MarimoNotebookCell>,
  _prefixLen: number,
  maxSuffix: number,
): number {
  let result = 0;

  for (let i = 0; i < maxSuffix; i++) {
    const oldIdx = oldCells.length - 1 - i;
    const newIdx = newCells.length - 1 - i;

    if (cellsEqual(oldCells[oldIdx], newCells[newIdx])) {
      result++;
    } else {
      break;
    }
  }

  return result;
}

/**
 * Check if two cells are equal (same content and kind).
 */
function cellsEqual(a: MarimoNotebookCell, b: MarimoNotebookCell): boolean {
  return (
    a.kind === b.kind &&
    a.document.languageId === b.document.languageId &&
    a.document.getText() === b.document.getText()
  );
}
