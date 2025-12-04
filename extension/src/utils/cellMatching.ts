import { Option } from "effect";
import type * as vscode from "vscode";

/**
 * Result of matching cached cells to incoming cells.
 *
 * Uses VSCode's prefix/suffix strategy for positional stability,
 * with content-based matching for the middle "changed" region.
 */
export interface CellDataMatchResult {
  /**
   * Number of cells from the start that match exactly at their positions.
   * For indices 0..(stablePrefix-1), cached[i] matches incoming[i].
   */
  stablePrefix: number;

  /**
   * Number of cells from the end that match exactly at their positions.
   * For indices (length-stableSuffix)..(length-1), the cells match positionally.
   */
  stableSuffix: number;

  /**
   * Content-based matches for the middle region (between prefix and suffix).
   * Maps cached cell index -> incoming cell index for cells that matched by content
   * but changed position.
   */
  middleMatches: Map<number, number>;
}

/**
 * Compare two cells for equality.
 * Cells are equal if they have the same kind, language, and content.
 */
function cellsEqual(
  a: vscode.NotebookCellData,
  b: vscode.NotebookCellData,
): boolean {
  return (
    a.kind === b.kind && a.languageId === b.languageId && a.value === b.value
  );
}

/**
 * Normalize content for fuzzy matching (whitespace changes only).
 */
function normalizeContent(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

/**
 * Match cached NotebookCellData to incoming NotebookCellData.
 *
 * Uses VSCode's notebook model strategy:
 * 1. Find common prefix - cells that match exactly at the start
 * 2. Find common suffix - cells that match exactly at the end
 * 3. For the middle region, use content-based matching
 *
 * This preserves positional stability: cells that didn't move keep their identity,
 * which is important for preserving outputs and metadata.
 */
export function matchCellData(
  cachedCells: ReadonlyArray<vscode.NotebookCellData>,
  incomingCells: ReadonlyArray<vscode.NotebookCellData>,
): CellDataMatchResult {
  // 1. Find common prefix - cells matching from the start
  const maxPrefix = Math.min(cachedCells.length, incomingCells.length);
  let stablePrefix = 0;
  for (
    let i = 0;
    i < maxPrefix && cellsEqual(cachedCells[i], incomingCells[i]);
    i++
  ) {
    stablePrefix++;
  }

  // Early exit if all cells match
  if (
    cachedCells.length === incomingCells.length &&
    stablePrefix === cachedCells.length
  ) {
    return { stablePrefix, stableSuffix: 0, middleMatches: new Map() };
  }

  // 2. Find common suffix - cells matching from the end
  // Only consider cells after the prefix
  const remainingCached = cachedCells.length - stablePrefix;
  const remainingIncoming = incomingCells.length - stablePrefix;
  const maxSuffix = Math.min(remainingCached, remainingIncoming);
  let stableSuffix = 0;
  for (let i = 0; i < maxSuffix; i++) {
    const cachedIdx = cachedCells.length - 1 - i;
    const incomingIdx = incomingCells.length - 1 - i;
    if (cellsEqual(cachedCells[cachedIdx], incomingCells[incomingIdx])) {
      stableSuffix++;
    } else {
      break;
    }
  }

  // 3. Content-based matching for the middle region
  const middleMatches = new Map<number, number>();

  const middleCachedStart = stablePrefix;
  const middleCachedEnd = cachedCells.length - stableSuffix;
  const middleIncomingStart = stablePrefix;
  const middleIncomingEnd = incomingCells.length - stableSuffix;

  // Build lists of unmatched indices in the middle region
  const unmatchedCachedIndices: Array<number> = [];
  for (let i = middleCachedStart; i < middleCachedEnd; i++) {
    unmatchedCachedIndices.push(i);
  }
  const unmatchedIncomingIndices: Array<number> = [];
  for (let i = middleIncomingStart; i < middleIncomingEnd; i++) {
    unmatchedIncomingIndices.push(i);
  }

  // Pass 1: Exact content match within middle region
  for (let i = unmatchedCachedIndices.length - 1; i >= 0; i--) {
    const cachedIdx = unmatchedCachedIndices[i];
    const cachedCell = cachedCells[cachedIdx];

    const matchPos = unmatchedIncomingIndices.findIndex((incomingIdx) =>
      cellsEqual(cachedCell, incomingCells[incomingIdx]),
    );

    if (matchPos !== -1) {
      const incomingIdx = unmatchedIncomingIndices[matchPos];
      middleMatches.set(cachedIdx, incomingIdx);
      unmatchedCachedIndices.splice(i, 1);
      unmatchedIncomingIndices.splice(matchPos, 1);
    }
  }

  // Pass 2: Normalized content match (whitespace-only changes)
  for (let i = unmatchedCachedIndices.length - 1; i >= 0; i--) {
    const cachedIdx = unmatchedCachedIndices[i];
    const cachedNormalized = normalizeContent(cachedCells[cachedIdx].value);

    const matchPos = unmatchedIncomingIndices.findIndex(
      (incomingIdx) =>
        normalizeContent(incomingCells[incomingIdx].value) === cachedNormalized,
    );

    if (matchPos !== -1) {
      const incomingIdx = unmatchedIncomingIndices[matchPos];
      middleMatches.set(cachedIdx, incomingIdx);
      unmatchedCachedIndices.splice(i, 1);
      unmatchedIncomingIndices.splice(matchPos, 1);
    }
  }

  return { stablePrefix, stableSuffix, middleMatches };
}

/**
 * Helper to find the cached cell index that matches a given incoming cell index.
 * Returns undefined if no match found.
 */
export function findCachedIndexForIncoming(
  result: CellDataMatchResult,
  options: {
    incomingIdx: number;
    cachedLength: number;
    incomingLength: number;
  },
): Option.Option<number> {
  const { incomingIdx, cachedLength, incomingLength } = options;
  // Check stable prefix
  if (incomingIdx < result.stablePrefix) {
    return Option.some(incomingIdx);
  }

  // Check stable suffix
  const suffixStart = incomingLength - result.stableSuffix;
  if (incomingIdx >= suffixStart) {
    const offsetFromEnd = incomingLength - incomingIdx;
    return Option.some(cachedLength - offsetFromEnd);
  }

  // Check middle matches
  for (const [cachedIdx, matchedIncomingIdx] of result.middleMatches) {
    if (matchedIncomingIdx === incomingIdx) {
      return Option.some(cachedIdx);
    }
  }

  return Option.none();
}
