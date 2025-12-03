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
 * Match removed cells to added cells based on content.
 *
 * Strategy:
 * 1. First try exact content match
 * 2. For remaining, try normalized content match (trimmed, whitespace normalized)
 * 3. Unmatched cells are considered truly deleted/added
 */
export function matchCells(
  removedCells: Array<MarimoNotebookCell>,
  addedCells: Array<MarimoNotebookCell>,
): CellMatchResult {
  const matched = new Map<NotebookCellId, MarimoNotebookCell>();
  const remainingRemoved = [...removedCells];
  const remainingAdded = [...addedCells];

  // Pass 1: Exact content match
  for (let i = remainingRemoved.length - 1; i >= 0; i--) {
    const removed = remainingRemoved[i];
    const removedContent = removed.document.getText();
    const stableId = removed.maybeId;

    if (Option.isNone(stableId)) {
      continue;
    }

    const matchIndex = remainingAdded.findIndex(
      (added) => added.document.getText() === removedContent,
    );

    if (matchIndex !== -1) {
      matched.set(stableId.value, remainingAdded[matchIndex]);
      remainingRemoved.splice(i, 1);
      remainingAdded.splice(matchIndex, 1);
    }
  }

  // Pass 2: Normalized content match (for whitespace-only changes)
  for (let i = remainingRemoved.length - 1; i >= 0; i--) {
    const removed = remainingRemoved[i];
    const removedNormalized = normalizeContent(removed.document.getText());
    const stableId = removed.maybeId;

    if (Option.isNone(stableId)) {
      continue;
    }

    const matchIndex = remainingAdded.findIndex(
      (added) =>
        normalizeContent(added.document.getText()) === removedNormalized,
    );

    if (matchIndex !== -1) {
      matched.set(stableId.value, remainingAdded[matchIndex]);
      remainingRemoved.splice(i, 1);
      remainingAdded.splice(matchIndex, 1);
    }
  }

  return {
    matched,
    unmatched: remainingRemoved,
    newCells: remainingAdded,
  };
}

function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}
