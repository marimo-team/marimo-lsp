import {
  Effect,
  Array as EffectArray,
  HashMap,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";
import {
  encodeCellMetadata,
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas.ts";
import { matchCells } from "../utils/cellMatching.ts";
import { Log } from "../utils/log.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { NotebookEditorRegistry } from "./NotebookEditorRegistry.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Manages cell stale state across all notebooks.
 *
 * Tracks which cells have been edited (stale) and updates:
 * 1. Cell metadata with state: "stale"
 * 2. VSCode context key "marimo.notebook.hasStaleCells" for UI enablement
 * 3. Backend about cell deletions
 *
 * Uses SubscriptionRef for reactive state management.
 */
export class CellStateManager extends Effect.Service<CellStateManager>()(
  "CellStateManager",
  {
    dependencies: [NotebookEditorRegistry.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      const client = yield* LanguageClient;

      // Track stale state: NotebookUri -> (CellIndex -> isStale)
      const staleStateRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, HashMap.HashMap<number, boolean>>(),
      );

      // Helper to update context based on current state
      const updateContext = Effect.fnUntraced(function* () {
        const [staleMap, activeMarimoNotebook] = yield* Effect.all([
          SubscriptionRef.get(staleStateRef),
          editorRegistry.getActiveNotebookUri(),
        ]);

        // Check if the active marimo notebook has any stale cells
        const hasStaleCells = Option.match(activeMarimoNotebook, {
          onNone: () => false,
          onSome: (notebookUri) => {
            const cellMap = HashMap.get(staleMap, notebookUri);
            return Option.match(cellMap, {
              onNone: () => false,
              onSome: (cells) => HashMap.size(cells) > 0,
            });
          },
        });

        yield* code.commands.setContext(
          "marimo.notebook.hasStaleCells",
          hasStaleCells,
        );
        yield* Log.debug("Updated stale context", { hasStaleCells });
      });

      // Set initial context state
      yield* Effect.forkScoped(updateContext());

      // Subscribe to stale state changes to update VSCode context
      yield* Effect.forkScoped(
        staleStateRef.changes.pipe(
          Stream.mapEffect(updateContext),
          Stream.runDrain,
        ),
      );

      // Subscribe to active notebook changes to update VSCode context
      yield* Effect.forkScoped(
        editorRegistry
          .streamActiveNotebookChanges()
          .pipe(Stream.mapEffect(updateContext), Stream.runDrain),
      );

      // Listen to notebook document changes
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges().pipe(
          Stream.filterMap((event) =>
            Option.map(
              MarimoNotebookDocument.tryFrom(event.notebook),
              (notebook) => ({ ...event, notebook }),
            ),
          ),
          Stream.runForEach(
            Effect.fnUntraced(function* (event) {
              yield* Effect.logTrace("onDidChangeNotebookDocument", {
                notebook: event.notebook.uri.fsPath,
                numCellChanges: event.cellChanges.length,
                newMetadata: event.metadata,
              });

              // Collect all removed and added cells from content changes
              const allRemovedCells: Array<MarimoNotebookCell> = [];
              const allAddedCells: Array<MarimoNotebookCell> = [];

              for (const change of event.contentChanges) {
                allRemovedCells.push(
                  ...change.removedCells.map(MarimoNotebookCell.from),
                );
                allAddedCells.push(
                  ...change.addedCells.map(MarimoNotebookCell.from),
                );
              }

              if (
                isLikelyRedeserialization({ allAddedCells, allRemovedCells })
              ) {
                yield* handleRedeserialization(
                  event.notebook,
                  allRemovedCells,
                  allAddedCells,
                  {
                    code,
                    notebookUri: event.notebook.id,
                    client,
                    staleStateRef,
                  },
                );
                return;
              }

              yield* handleNormalChange(event, allRemovedCells, allAddedCells, {
                code,
                client,
                staleStateRef,
              });
            }),
          ),
        ),
      );

      return {
        /**
         * Mark a cell as stale and update its metadata
         */
        markCellStale(notebookUri: NotebookId, cellIndex: number) {
          return Effect.gen(function* () {
            const notebook = Option.filterMap(
              yield* editorRegistry.getLastNotebookEditor(notebookUri),
              ({ notebook }) => MarimoNotebookDocument.tryFrom(notebook),
            );

            if (Option.isNone(notebook)) {
              yield* Log.warn("Notebook not found", { notebookUri });
              return;
            }

            yield* markCellStale(notebookUri, cellIndex, {
              code,
              staleStateRef,
              notebook: notebook.value,
            });
          });
        },

        /**
         * Clear stale state from a cell
         */
        clearCellStale(notebookUri: NotebookId, cellIndex: number) {
          return Effect.gen(function* () {
            const notebook =
              yield* editorRegistry.getLastNotebookEditor(notebookUri);

            if (Option.isNone(notebook)) {
              yield* Log.warn("Notebook not found for clearing stale", {
                notebookUri,
              });
              return;
            }

            const cell = notebook.value.notebook.cellAt(cellIndex);
            if (!cell) {
              yield* Log.warn("Cell not found", { notebookUri, cellIndex });
              return;
            }

            // Update cell metadata to remove stale state
            const edit = new code.WorkspaceEdit();
            const newMetadata = encodeCellMetadata({
              ...cell.metadata,
              state: undefined,
            });
            edit.set(notebook.value.notebook.uri, [
              code.NotebookEdit.updateCellMetadata(cellIndex, newMetadata),
            ]);
            yield* code.workspace.applyEdit(edit);

            // Update tracking
            yield* clearCellStaleTracking(notebookUri, cellIndex, {
              staleStateRef,
            });

            yield* Log.trace("Cleared cell stale state", {
              notebookUri,
              cellIndex,
            });
          });
        },

        /**
         * Get all stale cell indices for a notebook
         */
        getStaleCells(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const staleMap = yield* SubscriptionRef.get(staleStateRef);
            const cellMap = HashMap.get(staleMap, notebookUri);
            if (Option.isNone(cellMap)) {
              return [];
            }
            return Array.from(HashMap.keys(cellMap.value));
          });
        },

        /**
         * Get the changes stream for external subscriptions
         */
        get changes() {
          return staleStateRef.changes;
        },
      };
    }),
  },
) {}

/**
 * Mark a cell as stale in tracking and metadata
 */
function markCellStale(
  notebookUri: NotebookId,
  cellIndex: number,
  deps: {
    code: VsCode;
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<number, boolean>>
    >;
    notebook: MarimoNotebookDocument;
  },
) {
  return Effect.gen(function* () {
    const { code, staleStateRef, notebook } = deps;

    // Update tracking
    yield* SubscriptionRef.update(staleStateRef, (map) => {
      const notebookMap = Option.getOrElse(HashMap.get(map, notebookUri), () =>
        HashMap.empty<number, boolean>(),
      );
      const updatedNotebookMap = HashMap.set(notebookMap, cellIndex, true);
      return HashMap.set(map, notebookUri, updatedNotebookMap);
    });

    // Update cell metadata
    const cell = notebook.cellAt(cellIndex);
    if (!cell) {
      yield* Log.warn("Cell not found for marking stale", {
        notebookUri,
        cellIndex,
      });
      return;
    }

    const edit = new code.WorkspaceEdit();
    edit.set(notebook.uri, [
      code.NotebookEdit.updateCellMetadata(
        cellIndex,
        cell.buildEncodedMetadata({ overrides: { state: "stale" } }),
      ),
    ]);
    yield* code.workspace.applyEdit(edit);

    yield* Log.trace("Marked cell as stale", { notebookUri, cellIndex });
  });
}

/**
 * Clear stale tracking for a cell (doesn't modify metadata)
 */
function clearCellStaleTracking(
  notebookUri: NotebookId,
  cellIndex: number,
  deps: {
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<number, boolean>>
    >;
  },
) {
  return Effect.gen(function* () {
    const { staleStateRef } = deps;

    yield* SubscriptionRef.update(staleStateRef, (map) => {
      const notebookMap = HashMap.get(map, notebookUri);
      if (Option.isNone(notebookMap)) {
        return map;
      }

      const updatedNotebookMap = HashMap.remove(notebookMap.value, cellIndex);
      if (HashMap.isEmpty(updatedNotebookMap)) {
        // Remove the notebook entry if no more stale cells
        return HashMap.remove(map, notebookUri);
      }

      return HashMap.set(map, notebookUri, updatedNotebookMap);
    });

    yield* Log.trace("Cleared cell from stale tracking", {
      notebookUri,
      cellIndex,
    });
  });
}

/**
 * Handle notebook re-deserialization by matching old cells to new cells
 * and transferring stable IDs.
 *
 * When VS Code re-deserializes a notebook (on save, agent use, external edit),
 * it replaces all cells with new ones. This function:
 *
 * 1. Matches old cells to new cells by content
 * 2. Transfers stable IDs from matched old cells to new cells
 * 3. Generates new stable IDs for truly new cells
 * 4. Notifies backend about truly deleted cells
 */
function handleRedeserialization(
  notebook: MarimoNotebookDocument,
  removedCells: Array<MarimoNotebookCell>,
  addedCells: Array<MarimoNotebookCell>,
  deps: {
    code: VsCode;
    notebookUri: NotebookId;
    client: LanguageClient;
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<number, boolean>>
    >;
  },
) {
  return Effect.gen(function* () {
    const { code, notebookUri, client, staleStateRef } = deps;

    yield* Log.debug("Detected re-deserialization", {
      notebookUri,
      removedCount: removedCells.length,
      addedCount: addedCells.length,
    });

    const matchResult = matchCells(removedCells, addedCells);

    yield* Log.trace("Cell matching results", {
      matchedCount: matchResult.matched.size,
      unmatchedRemovedCount: matchResult.unmatched.length,
      newCellsCount: matchResult.newCells.length,
    });

    // Transfer stable IDs and outputs from matched old cells to new cells
    const edit = new code.WorkspaceEdit();

    // Build a map of stableId -> oldCell for quick lookup
    const oldCellsByStableId = new Map(
      EffectArray.getSomes(
        removedCells.map((cell) =>
          Option.map(cell.maybeId, (id) => [id, cell] as const),
        ),
      ),
    );

    for (const [stableId, newCell] of matchResult.matched) {
      // Transfer outputs from the matched old cell
      const oldCell = oldCellsByStableId.get(stableId);
      const newOutputs = [...(oldCell?.outputs ?? [])];

      // Ensure new metadata has old stableId
      const newMetadata = newCell.buildEncodedMetadata({
        overrides: { stableId },
      });

      // Replace the cell with updated metadata and outputs
      const cellData = new code.NotebookCellData(
        newCell.kind,
        newCell.document.getText(),
        newCell.document.languageId,
      );
      cellData.outputs = newOutputs;
      cellData.metadata = newMetadata;

      edit.set(notebook.uri, [
        code.NotebookEdit.replaceCells(
          new code.NotebookRange(newCell.index, newCell.index + 1),
          [cellData],
        ),
      ]);
    }

    // For truly new cells, ensure they have stable IDs
    edit.set(notebook.uri, assignStableIdsToCells(matchResult.newCells, code));

    // Apply edits and save
    yield* code.workspace.applyEdit(edit);
    yield* notebook.save();

    // Clear stale tracking for all cells (fresh state after re-deserialization)
    yield* SubscriptionRef.update(staleStateRef, HashMap.remove(notebookUri));

    // Notify backend about truly deleted cells (using stable ID)
    for (const deletedCell of matchResult.unmatched) {
      yield* notifyBackendCellDelete(client, notebook, deletedCell);
    }

    yield* Log.debug("Re-deserialization handled", { notebookUri });
  });
}

/**
 * Detects potential re-deserialization
 *
 * When VS Code re-deserializes (save, agent, external edit),
 * it removes
 * all old cells and adds new cells. We detect this by checking if
 * removed and added counts are non-zero, all new cells have empty outputs,
 * and at least one old cell has outputs.
 */
function isLikelyRedeserialization(options: {
  allAddedCells: Array<MarimoNotebookCell>;
  allRemovedCells: Array<MarimoNotebookCell>;
}) {
  const { allRemovedCells, allAddedCells } = options;
  const allNewCellsHaveEmptyOutputs = allAddedCells.every(
    (cell) => cell.outputs.length === 0,
  );
  const someOldCellsHaveOutputs = allRemovedCells.some(
    (cell) => cell.outputs.length > 0,
  );
  return (
    allRemovedCells.length > 0 &&
    allAddedCells.length > 0 &&
    allNewCellsHaveEmptyOutputs &&
    someOldCellsHaveOutputs
  );
}

const notifyBackendCellDelete = Effect.fn("deleteCell")(function* (
  client: LanguageClient,
  notebook: MarimoNotebookDocument,
  cell: MarimoNotebookCell,
) {
  const stableId = cell.maybeId;

  if (Option.isNone(stableId)) {
    yield* Effect.logWarning(
      `Missing stable id for cell delete: ${cell.document.uri.toString()}`,
    );
    return;
  }

  yield* client
    .executeCommand({
      command: "marimo.api",
      params: {
        method: "delete_cell",
        params: {
          notebookUri: notebook.id,
          inner: {
            cellId: stableId.value,
          },
        },
      },
    })
    .pipe(
      Effect.catchAllCause((cause) =>
        Effect.logWarning(
          "Failed to notify backend about cell deletion",
          cause,
        ).pipe(
          Effect.annotateLogs({
            notebookUri: notebook.id,
            stableId: stableId.value,
          }),
        ),
      ),
    );
});

/**
 * Creates a `vscode.NotebookEdit` for any cells that do not have a stableId
 * Returns an empty list if all cells already contain a `stableId`.
 */
function assignStableIdsToCells(
  cells: Array<MarimoNotebookCell>,
  code: VsCode,
): ReadonlyArray<vscode.NotebookEdit> {
  const edits: Array<vscode.NotebookEdit> = [];

  for (const cell of cells) {
    if (Option.isSome(cell.maybeId)) {
      continue;
    }

    const stableId = crypto.randomUUID();
    edits.push(
      code.NotebookEdit.updateCellMetadata(
        cell.index,
        cell.buildEncodedMetadata({ overrides: { stableId } }),
      ),
    );
  }
  return edits;
}

/**
 * Handles normal notebook changes (not re-deserialization).
 *
 * Processes:
 * 1. Cell deletions - notifies backend about truly deleted cells (not moves)
 * 2. Cell edits - marks cells stale on content change, clears stale on execution
 * 3. New cells - assigns stable IDs to cells that don't have them
 */
function handleNormalChange(
  event: {
    notebook: MarimoNotebookDocument;
    cellChanges: ReadonlyArray<vscode.NotebookDocumentCellChange>;
  },
  allRemovedCells: Array<MarimoNotebookCell>,
  allAddedCells: Array<MarimoNotebookCell>,
  deps: {
    code: VsCode;
    client: LanguageClient;
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<number, boolean>>
    >;
  },
) {
  return Effect.gen(function* () {
    const { code, client, staleStateRef } = deps;
    const notebookId = event.notebook.id;

    // --- Cell Deletions ---
    // When a cell is moved, VSCode reports it as removed AND added
    // We need to filter out moved cells to find truly deleted cells
    const addedCellIds = new Set(
      EffectArray.getSomes(allAddedCells.map((c) => c.maybeId)),
    );
    const removedCellsMap = new Map(
      EffectArray.getSomes(
        allRemovedCells.map((cell) =>
          Option.map(cell.maybeId, (id) => [id, cell] as const),
        ),
      ),
    );

    // Process truly deleted cells (removed but not added back)
    for (const [cellId, cell] of removedCellsMap) {
      if (addedCellIds.has(cellId)) {
        continue; // Cell was moved, not deleted
      }

      yield* clearCellStaleTracking(notebookId, cell.index, { staleStateRef });
      yield* notifyBackendCellDelete(client, event.notebook, cell);
    }

    // --- Cell Edits ---
    for (const cellChange of event.cellChanges) {
      const cell = MarimoNotebookCell.from(cellChange.cell);

      // Content changed → mark stale
      if (cellChange.document) {
        yield* Log.trace("Cell content changed", {
          notebookUri: notebookId,
          cellIndex: cell.index,
        });
        yield* markCellStale(notebookId, cell.index, {
          code,
          staleStateRef,
          notebook: event.notebook,
        });
      }

      // Metadata changed to non-stale → clear tracking (e.g., cleared by execution)
      if (cellChange.metadata && !cell.isStale) {
        yield* clearCellStaleTracking(notebookId, cell.index, {
          staleStateRef,
        });
      }
    }

    // --- Ensure stable IDs for new cells ---
    const stableIdEdits = assignStableIdsToCells(allAddedCells, code);
    if (stableIdEdits.length > 0) {
      const edit = new code.WorkspaceEdit();
      edit.set(event.notebook.uri, stableIdEdits);
      yield* code.workspace.applyEdit(edit);
      yield* Log.debug(
        `Assigned ${stableIdEdits.length} stable IDs to new cells`,
      );
    }
  });
}
