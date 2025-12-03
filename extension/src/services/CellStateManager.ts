import { Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import {
  decodeCellMetadata,
  encodeCellMetadata,
  MarimoNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId,
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
    scoped: Effect.gen(function*() {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      const client = yield* LanguageClient;

      // Track stale state: NotebookUri -> (CellIndex -> isStale)
      const staleStateRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, HashMap.HashMap<number, boolean>>(),
      );

      // Helper to update context based on current state
      const updateContext = Effect.fnUntraced(function*() {
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
            Effect.fnUntraced(function*(event) {
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

              // Detect potential re-deserialization:
              // When VS Code re-deserializes (save, agent, external edit), it removes
              // all old cells and adds new cells. We detect this by checking if
              // removed and added counts are non-zero, all new cells have empty outputs,
              // and at least one old cell has outputs.
              const allNewCellsHaveEmptyOutputs = allAddedCells.every(
                (cell) => cell.outputs.length === 0,
              );
              const someOldCellsHaveOutputs = allRemovedCells.some(
                (cell) => cell.outputs.length > 0,
              );
              const isLikelyRedeserialization =
                allRemovedCells.length > 0 &&
                allAddedCells.length > 0 &&
                allNewCellsHaveEmptyOutputs &&
                someOldCellsHaveOutputs;

              if (isLikelyRedeserialization) {
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
                // Skip normal processing - re-deserialization handled everything
                return;
              }

              // Normal processing: handle cell deletions
              // When a cell is moved, VSCode reports it as removed AND added
              // We need to filter out moved cells to find truly deleted cells
              const removedCellIds = new Set<NotebookCellId>();
              const addedCellIds = new Set<NotebookCellId>();
              const removedCellsMap = new Map<NotebookCellId, MarimoNotebookCell>();

              for (const cell of allAddedCells) {
                Option.map(cell.maybeId, (stableId) => addedCellIds.add(stableId));
              }

              for (const cell of allRemovedCells) {
                Option.map(cell.maybeId, stableId => {
                  removedCellIds.add(stableId);
                  removedCellsMap.set(stableId, cell);
                })
              }

              // Find truly deleted cells (removed but not added)
              const trulyDeletedCellIds = Array.from(removedCellIds).filter(
                (cellId) => !addedCellIds.has(cellId),
              );

              // Process only truly deleted cells
              for (const cellId of trulyDeletedCellIds) {
                const cell = removedCellsMap.get(cellId);
                if (!cell) {
                  continue;
                }

                // Clear local tracking
                yield* clearCellStaleTracking(event.notebook.id, cell.index, {
                  staleStateRef,
                });

                // Notify backend about cell deletion
                yield* client
                  .executeCommand({
                    command: "marimo.api",
                    params: {
                      method: "delete_cell",
                      params: {
                        notebookUri: event.notebook.id,
                        inner: {
                          cellId,
                        },
                      },
                    },
                  })
                  .pipe(
                    Effect.catchAllCause((cause) =>
                      // TODO: should we add this back to the UI on failure?
                      Effect.logWarning(
                        "Failed to notify backend about cell deletion",
                        cause,
                      ).pipe(
                        Effect.annotateLogs({
                          notebookUri: event.notebook.id,
                          cellIndex: cell.index,
                        }),
                      ),
                    ),
                  );
              }

              // Process cell changes (content or metadata edits)
              for (const cellChange of event.cellChanges) {
                const cell = cellChange.cell;
                const cellIndex = cell.index;

                // Check if document (content) changed
                if (cellChange.document) {
                  yield* Log.trace("Cell content changed", {
                    notebookUri: event.notebook.id,
                    cellIndex,
                  });

                  // Mark cell as stale
                  yield* markCellStale(event.notebook.id, cellIndex, {
                    code,
                    staleStateRef,
                    notebook: event.notebook,
                  });
                }

                // No metadata change
                if (!cellChange.metadata) {
                  continue;
                }

                // Check if metadata changed and state is not stale
                // (e.g., cleared by execution)
                const metadata = decodeCellMetadata(cellChange.metadata);
                if (
                  Option.isSome(metadata) &&
                  metadata.value.state !== "stale"
                ) {
                  yield* clearCellStaleTracking(event.notebook.id, cellIndex, {
                    staleStateRef,
                  });
                }
              }
            }),
          ),
        ),
      );

      return {
        /**
         * Mark a cell as stale and update its metadata
         */
        markCellStale(notebookUri: NotebookId, cellIndex: number) {
          return Effect.gen(function*() {
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
          return Effect.gen(function*() {
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
          return Effect.gen(function*() {
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
) { }

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
  return Effect.gen(function*() {
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
  return Effect.gen(function*() {
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
  return Effect.gen(function*() {
    const { code, notebookUri, client, staleStateRef } = deps;

    yield* Log.debug("Detected re-deserialization", {
      notebookUri,
      removedCount: removedCells.length,
      addedCount: addedCells.length,
    });

    const matchResult = matchCells(removedCells, addedCells);

    yield* Log.debug("Cell matching results", {
      matchedCount: matchResult.matched.size,
      unmatchedRemovedCount: matchResult.unmatched.length,
      newCellsCount: matchResult.newCells.length,
    });

    // Transfer stable IDs and outputs from matched old cells to new cells
    const edit = new code.WorkspaceEdit();

    // Build a map of stableId -> oldCell for quick lookup
    const oldCellsByStableId = new Map<string, MarimoNotebookCell>();
    for (const oldCell of removedCells) {
      if (Option.isSome(oldCell.maybeId)) {
        oldCellsByStableId.set(oldCell.maybeId.value, oldCell);
      }
    }

    for (const [stableId, newCell] of matchResult.matched) {
      const existingMeta = newCell.metadata ?? {};
      const newMetadata = encodeCellMetadata({
        ...existingMeta,
        stableId,
      });

      // Transfer outputs from the matched old cell
      const oldCell = oldCellsByStableId.get(stableId);
      const outputsToUse = oldCell?.outputs ?? [];

      // Replace the cell with updated metadata and outputs
      const cellData = new code.NotebookCellData(
        newCell.kind,
        newCell.document.getText(),
        newCell.document.languageId,
      );
      cellData.metadata = newMetadata;
      cellData.outputs = [...outputsToUse];

      edit.set(notebook.uri, [
        code.NotebookEdit.replaceCells(
          new code.NotebookRange(newCell.index, newCell.index + 1),
          [cellData],
        ),
      ]);
    }

    // For truly new cells, ensure they have stable IDs
    for (const newCell of matchResult.newCells) {
      if (Option.isNone(newCell.maybeId)) {
        const existingMeta = newCell.metadata ?? {};
        const newMetadata = encodeCellMetadata({
          ...existingMeta,
          stableId: crypto.randomUUID(),
        });
        edit.set(notebook.uri, [
          code.NotebookEdit.updateCellMetadata(newCell.index, newMetadata),
        ]);
      }
    }

    yield* code.workspace.applyEdit(edit);
    yield* notebook.save();

    // Clear stale tracking for all cells (fresh state after re-deserialization)
    yield* SubscriptionRef.update(staleStateRef, HashMap.remove(notebookUri));

    // Notify backend about truly deleted cells (using stable ID)
    for (const deletedCell of matchResult.unmatched) {
      const stableId = deletedCell.maybeId;

      if (Option.isNone(stableId)) {
        continue;
      }

      yield* client
        .executeCommand({
          command: "marimo.api",
          params: {
            method: "delete_cell",
            params: {
              notebookUri,
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
                notebookUri,
                stableId: stableId.value,
              }),
            ),
          ),
        );
    }

    yield* Log.debug("Re-deserialization handled", { notebookUri });
  });
}
