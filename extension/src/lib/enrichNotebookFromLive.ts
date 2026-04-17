import { Option } from "effect";
import type * as vscode from "vscode";

/**
 * Enrich freshly-deserialized notebook data with outputs and stable IDs
 * sourced from the live `NotebookDocument` that `incoming` corresponds to.
 *
 * The caller is responsible for identifying the right live document (see
 * `pickLiveNotebook`) and snapshotting its cells into `NotebookCellData`
 * shape before calling in. The cell-level mapping uses VS Code's
 * prefix/suffix + content strategy so inserts, edits-in-place, and
 * reorderings preserve cell identity.
 *
 * @param incoming - Freshly deserialized notebook data (fresh stableIds, no outputs)
 * @param live - Snapshot of the matched live NotebookDocument's cells
 * @returns Enriched notebook data with preserved outputs and stable IDs
 */
export function enrichNotebookFromLive(
  incoming: vscode.NotebookData,
  live: vscode.NotebookData,
): vscode.NotebookData {
  const matchResult = matchCells(live.cells, incoming.cells);

  const enrichedCells = incoming.cells.map((incomingCell, incomingIdx) => {
    const liveIdx = findLiveIndexForIncoming(matchResult, {
      incomingIdx,
      incomingLength: incoming.cells.length,
      liveLength: live.cells.length,
    });

    if (Option.isSome(liveIdx)) {
      const liveCell = live.cells[liveIdx.value];
      incomingCell.metadata = {
        ...incomingCell.metadata,
        stale: liveCell.metadata?.stale ?? incomingCell.metadata?.stale,
        stableId:
          liveCell.metadata?.stableId ?? incomingCell.metadata?.stableId,
      };
      incomingCell.outputs = liveCell.outputs ?? incomingCell.outputs;
    }

    return incomingCell;
  });

  incoming.cells = enrichedCells;
  return incoming;
}

/**
 * Result of matching live cells to incoming cells.
 *
 * Uses VSCode's prefix/suffix strategy for positional stability,
 * with content-based matching for the middle "changed" region.
 */
interface CellMatchResult {
  /**
   * Number of cells from the start that match exactly at their positions.
   * For indices 0..(stablePrefix-1), live[i] matches incoming[i].
   */
  stablePrefix: number;

  /**
   * Number of cells from the end that match exactly at their positions.
   * For indices (length-stableSuffix)..(length-1), the cells match positionally.
   */
  stableSuffix: number;

  /**
   * Content-based matches for the middle region (between prefix and suffix).
   * Maps live cell index -> incoming cell index for cells that matched by
   * content but changed position.
   */
  middleMatches: Map<number, number>;
}

/**
 * Match live NotebookCellData to incoming NotebookCellData.
 *
 * Uses VSCode's notebook model strategy:
 * 1. Find common prefix - cells that match exactly at the start
 * 2. Find common suffix - cells that match exactly at the end
 * 3. For the middle region, use content-based matching
 *
 * This preserves positional stability: cells that didn't move keep their identity,
 * which is important for preserving outputs and metadata.
 */
function matchCells(
  liveCells: ReadonlyArray<vscode.NotebookCellData>,
  incomingCells: ReadonlyArray<vscode.NotebookCellData>,
): CellMatchResult {
  // 1. Find common prefix - cells matching from the start
  const maxPrefix = Math.min(liveCells.length, incomingCells.length);
  let stablePrefix = 0;
  for (
    let i = 0;
    i < maxPrefix && cellsEqual(liveCells[i], incomingCells[i]);
    i++
  ) {
    stablePrefix++;
  }

  // Early exit if all cells match
  if (
    liveCells.length === incomingCells.length &&
    stablePrefix === liveCells.length
  ) {
    return { stablePrefix, stableSuffix: 0, middleMatches: new Map() };
  }

  // 2. Find common suffix - cells matching from the end
  // Only consider cells after the prefix
  const remainingLive = liveCells.length - stablePrefix;
  const remainingIncoming = incomingCells.length - stablePrefix;
  const maxSuffix = Math.min(remainingLive, remainingIncoming);
  let stableSuffix = 0;
  for (let i = 0; i < maxSuffix; i++) {
    const liveIdx = liveCells.length - 1 - i;
    const incomingIdx = incomingCells.length - 1 - i;
    if (cellsEqual(liveCells[liveIdx], incomingCells[incomingIdx])) {
      stableSuffix++;
    } else {
      break;
    }
  }

  // 3. Content-based matching for the middle region
  const middleMatches = new Map<number, number>();

  const middleLiveStart = stablePrefix;
  const middleLiveEnd = liveCells.length - stableSuffix;
  const middleIncomingStart = stablePrefix;
  const middleIncomingEnd = incomingCells.length - stableSuffix;

  // Build lists of unmatched indices in the middle region
  const unmatchedLiveIndices: Array<number> = [];
  for (let i = middleLiveStart; i < middleLiveEnd; i++) {
    unmatchedLiveIndices.push(i);
  }
  const unmatchedIncomingIndices: Array<number> = [];
  for (let i = middleIncomingStart; i < middleIncomingEnd; i++) {
    unmatchedIncomingIndices.push(i);
  }

  // Pass 1: Exact content match within middle region
  for (let i = unmatchedLiveIndices.length - 1; i >= 0; i--) {
    const liveIdx = unmatchedLiveIndices[i];
    const liveCell = liveCells[liveIdx];

    const matchPos = unmatchedIncomingIndices.findIndex((incomingIdx) =>
      cellsEqual(liveCell, incomingCells[incomingIdx]),
    );

    if (matchPos !== -1) {
      const incomingIdx = unmatchedIncomingIndices[matchPos];
      middleMatches.set(liveIdx, incomingIdx);
      unmatchedLiveIndices.splice(i, 1);
      unmatchedIncomingIndices.splice(matchPos, 1);
    }
  }

  // Pass 2: Normalized content match (whitespace-only changes)
  for (let i = unmatchedLiveIndices.length - 1; i >= 0; i--) {
    const liveIdx = unmatchedLiveIndices[i];
    const liveNormalized = normalizeContent(liveCells[liveIdx].value);

    const matchPos = unmatchedIncomingIndices.findIndex(
      (incomingIdx) =>
        normalizeContent(incomingCells[incomingIdx].value) === liveNormalized,
    );

    if (matchPos !== -1) {
      const incomingIdx = unmatchedIncomingIndices[matchPos];
      middleMatches.set(liveIdx, incomingIdx);
      unmatchedLiveIndices.splice(i, 1);
      unmatchedIncomingIndices.splice(matchPos, 1);
    }
  }

  // Pass 3: Positional fallback — pair remaining unmatched cells by order.
  // This handles the common case of external edits (e.g., AI tools) modifying
  // cell content in place without adding or removing cells.
  const pairCount = Math.min(
    unmatchedLiveIndices.length,
    unmatchedIncomingIndices.length,
  );
  for (let i = 0; i < pairCount; i++) {
    middleMatches.set(unmatchedLiveIndices[i], unmatchedIncomingIndices[i]);
  }

  return { stablePrefix, stableSuffix, middleMatches };
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
 * Normalize content for fuzzy matching - just trims leading/trailing whitespace.
 */
function normalizeContent(content: string): string {
  return content.trim();
}

/**
 * Find the live cell index that matches a given incoming cell index.
 */
function findLiveIndexForIncoming(
  result: CellMatchResult,
  options: {
    incomingIdx: number;
    liveLength: number;
    incomingLength: number;
  },
): Option.Option<number> {
  const { incomingIdx, liveLength, incomingLength } = options;
  // Check stable prefix
  if (incomingIdx < result.stablePrefix) {
    return Option.some(incomingIdx);
  }

  // Check stable suffix
  const suffixStart = incomingLength - result.stableSuffix;
  if (incomingIdx >= suffixStart) {
    const offsetFromEnd = incomingLength - incomingIdx;
    return Option.some(liveLength - offsetFromEnd);
  }

  // Check middle matches
  for (const [liveIdx, matchedIncomingIdx] of result.middleMatches) {
    if (matchedIncomingIdx === incomingIdx) {
      return Option.some(liveIdx);
    }
  }

  return Option.none();
}
