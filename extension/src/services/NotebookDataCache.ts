import { Effect, Option, Stream } from "effect";
import type * as vscode from "vscode";
import type { NotebookId } from "../schemas.ts";
import { MarimoNotebookDocument } from "../schemas.ts";
import { VsCode } from "./VsCode.ts";

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
            return Option.none<vscode.NotebookData>();
          }

          const notebookId = yield* matchRecentNotebookFromBytes(bytes, {
            code: code.value,
            recentlyEdited,
          });

          if (Option.isNone(notebookId)) {
            yield* Effect.logDebug("Could not match notebook from bytes");
            return Option.none<vscode.NotebookData>();
          }

          const cachedData = lastNotebookData.get(notebookId.value);
          if (!cachedData) {
            yield* Effect.logDebug("No cached data found for notebook").pipe(
              Effect.annotateLogs({ notebookId: notebookId.value }),
            );
            return Option.none<vscode.NotebookData>();
          }

          return Option.some(cachedData);
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
      if (Option.isSome(cell.id) && dataStableIds.has(cell.id.value)) {
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
