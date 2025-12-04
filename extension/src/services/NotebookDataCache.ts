import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import type { NotebookId } from "../schemas.ts";
import { MarimoNotebookDocument } from "../schemas.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Cached notebook data with its associated notebook ID.
 */
export interface CachedNotebookData {
  notebookId: NotebookId;
  data: vscode.NotebookData;
}

/**
 * A cache for preserving notebook cell outputs and stable IDs across
 * serialize/deserialize cycles.
 *
 * ## Problem This Solves
 *
 * When a marimo notebook is saved, the serialization process converts
 * VS Code's NotebookData to Python source code. This Python source does NOT
 * contain cell outputs or stable IDs - those are ephemeral VS Code concepts.
 *
 * When the file is later re-read (e.g., after external edits, git operations,
 * or formatter changes), deserialization creates fresh NotebookData with new
 * random stable IDs and no outputs. This causes:
 * - Loss of cell outputs (users see blank cells)
 * - Loss of stable IDs (breaks cell identity tracking)
 *
 * ## How It Works
 *
 * 1. **On Serialize**: Before converting to Python, we cache the NotebookData
 *    (which contains outputs and stable IDs). We identify the notebook by
 *    matching stable IDs from the data against recently-edited notebooks.
 *
 * 2. **On Deserialize**: After parsing Python back to NotebookData, we look up
 *    cached data by comparing the incoming bytes against recently-edited files.
 *    If found, we "enrich" the freshly-deserialized data by restoring outputs
 *    and stable IDs from the cache.
 *
 * ## Usage Pattern
 *
 * ```typescript
 * const cache = yield* NotebookDataCache;
 *
 * // During serialize (before converting to bytes):
 * yield* cache.set(notebookData);
 * const bytes = yield* serialize(notebookData);
 *
 * // During deserialize (after parsing bytes):
 * const freshData = yield* deserialize(bytes);
 * const cached = yield* cache.get(bytes);
 * const enrichedData = cache.enrich(freshData, cached);
 * ```
 *
 * ## Cell Matching Strategy
 *
 * The `enrich` method uses a prefix/suffix/middle matching strategy:
 * - Cells at the start that haven't changed keep their identity (stable prefix)
 * - Cells at the end that haven't changed keep their identity (stable suffix)
 * - Cells in the middle are matched by content (exact, then normalized)
 *
 * This handles common scenarios like:
 * - Formatter changing whitespace (cells match by normalized content)
 * - Adding/removing cells in the middle (prefix/suffix remain stable)
 * - Reordering cells (content-based matching finds them)
 */
export class NotebookDataCache extends Effect.Service<NotebookDataCache>()(
  "NotebookDataCache",
  {
    dependencies: [],
    scoped: Effect.gen(function* () {
      const code = yield* Effect.serviceOption(VsCode);

      const recentlyEdited = new MruList(
        (doc: MarimoNotebookDocument) => doc.id,
      );
      const lastNotebookData = new Map<NotebookId, vscode.NotebookData>();

      if (Option.isSome(code)) {
        yield* Effect.forkScoped(
          code.value.workspace.notebookDocumentOpened().pipe(
            Stream.flatMap((doc) => MarimoNotebookDocument.tryFrom(doc)),
            Stream.runForEach((doc) =>
              Effect.sync(() => recentlyEdited.touch(doc)),
            ),
          ),
        );
        yield* Effect.forkScoped(
          code.value.workspace.notebookDocumentChanges().pipe(
            Stream.flatMap((e) => MarimoNotebookDocument.tryFrom(e.notebook)),
            Stream.runForEach((doc) =>
              Effect.sync(() => recentlyEdited.touch(doc)),
            ),
          ),
        );
      }

      return {
        set: Effect.fnUntraced(function* (data: vscode.NotebookData) {
          const notebook = matchRecentNotebookFromData(data, recentlyEdited);

          if (Option.isNone(notebook)) {
            yield* Effect.logDebug("Could not match notebook for caching");
            return;
          }

          lastNotebookData.set(notebook.value.id, data);
          yield* Effect.logDebug("Cached notebook data").pipe(
            Effect.annotateLogs({ notebookId: notebook.value.id }),
          );
        }),
        get: Effect.fnUntraced(function* (bytes: Uint8Array) {
          if (Option.isNone(code)) {
            yield* Effect.logDebug(
              "Cache lookup requires VsCode service, skipping",
            );
            return Option.none<CachedNotebookData>();
          }

          const notebookId = yield* matchRecentNotebookFromBytes(bytes, {
            code: code.value,
            recentlyEdited,
          });

          if (Option.isNone(notebookId)) {
            yield* Effect.logDebug("Could not match notebook from bytes");
            return Option.none<CachedNotebookData>();
          }

          const cachedData = lastNotebookData.get(notebookId.value);
          if (!cachedData) {
            yield* Effect.logDebug("No cached data found for notebook").pipe(
              Effect.annotateLogs({ notebookId: notebookId.value }),
            );
            return Option.none<CachedNotebookData>();
          }

          return Option.some({
            notebookId: notebookId.value,
            data: cachedData,
          });
        }),
        enrich: Effect.fnUntraced(function* (
          data: vscode.NotebookData,
          cached: CachedNotebookData,
        ) {
          const { notebookId, data: cachedData } = cached;

          // Match cells using prefix/suffix + content matching
          const matchResult = matchCellData(cachedData.cells, data.cells);

          // Build enriched cells array
          let matchedCount = 0;
          const enrichedCells = data.cells.map((incomingCell, incomingIdx) => {
            const cachedIdx = findCachedIndexForIncoming(matchResult, {
              incomingIdx,
              incomingLength: data.cells.length,
              cachedLength: cachedData.cells.length,
            });

            if (Option.isSome(cachedIdx)) {
              matchedCount++;
              const cachedCell = cachedData.cells[cachedIdx.value];
              return {
                ...incomingCell,
                metadata: {
                  ...incomingCell.metadata,
                  stableId:
                    cachedCell.metadata?.stableId ??
                    incomingCell.metadata?.stableId,
                },
                outputs: cachedCell.outputs ?? incomingCell.outputs,
              };
            }

            // No match found, keep the incoming cell as-is
            return incomingCell;
          });

          yield* Effect.logDebug("Enriched notebook from cache").pipe(
            Effect.annotateLogs({
              notebookId,
              stablePrefix: matchResult.stablePrefix,
              stableSuffix: matchResult.stableSuffix,
              middleMatches: matchResult.middleMatches.size,
              totalMatched: matchedCount,
            }),
          );

          return { ...data, cells: enrichedCells };
        }),
      };
    }),
  },
) {}

/**
 * A list that tracks items by most-recently-touched order.
 *
 * Uses a Map internally, which maintains insertion order.
 * Touching an item removes and re-inserts it, moving it to the end.
 * Iteration yields items from most recent to least recent.
 */
class MruList<K, V> {
  #items = new Map<K, V>();
  #keyFn: (value: V) => K;

  constructor(keyFn: (value: V) => K) {
    this.#keyFn = keyFn;
  }

  touch(item: V): void {
    const key = this.#keyFn(item);
    this.#items.delete(key);
    this.#items.set(key, item);
  }

  take(limit: number): Array<V> {
    return [...this.#items.values()].reverse().slice(0, limit);
  }
}

const matchRecentNotebookFromData = (
  data: vscode.NotebookData,
  recentlyEdited: MruList<NotebookId, MarimoNotebookDocument>,
): Option.Option<MarimoNotebookDocument> => {
  // Collect all stableIds from the NotebookData cells
  const dataStableIds = new Set(
    data.cells
      .map((cell) => cell.metadata?.stableId)
      .filter((id): id is string => typeof id === "string"),
  );

  if (dataStableIds.size === 0) {
    return Option.none();
  }

  // Find a notebook that has any of these stableIds
  for (const doc of recentlyEdited.take(5)) {
    for (const cell of doc.getCells()) {
      if (
        Option.isSome(cell.maybeId) &&
        dataStableIds.has(cell.maybeId.value)
      ) {
        return Option.some(doc);
      }
    }
  }
  return Option.none();
};

const matchRecentNotebookFromBytes = Effect.fnUntraced(function* (
  bytes: Uint8Array,
  deps: {
    code: VsCode;
    recentlyEdited: MruList<NotebookId, MarimoNotebookDocument>;
  },
) {
  const { code, recentlyEdited } = deps;

  const incomingContent = new TextDecoder().decode(bytes);

  for (const doc of recentlyEdited.take(5)) {
    const fileBytes = yield* code.workspace.fs
      .readFile(doc.uri)
      .pipe(Effect.option);

    if (Option.isNone(fileBytes)) {
      continue;
    }

    const fileContent = new TextDecoder().decode(fileBytes.value);
    if (fileContent === incomingContent) {
      return Option.some(doc.id);
    }
  }
  return Option.none<NotebookId>();
});

/**
 * Result of matching cached cells to incoming cells.
 *
 * Uses VSCode's prefix/suffix strategy for positional stability,
 * with content-based matching for the middle "changed" region.
 */
interface CellDataMatchResult {
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
function matchCellData(
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
function findCachedIndexForIncoming(
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
