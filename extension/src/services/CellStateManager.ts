import { Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
  type NotebookId,
} from "../schemas.ts";
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

              // Process cell deletions
              // When a cell is moved, VSCode reports it as removed AND added
              // We need to filter out moved cells to find truly deleted cells
              const removedCellIds = new Set<NotebookCellId>();
              const addedCellIds = new Set<NotebookCellId>();
              const removedCellsMap = new Map<
                NotebookCellId,
                MarimoNotebookCell
              >();

              // Collect all removed and added cell IDs
              const edits: Array<vscode.NotebookEdit> = [];
              for (const change of event.contentChanges) {
                for (const rawCell of change.removedCells) {
                  const cell = MarimoNotebookCell.from(rawCell);
                  if (Option.isSome(cell.maybeId)) {
                    removedCellIds.add(cell.maybeId.value);
                    removedCellsMap.set(cell.maybeId.value, cell);
                  }
                }

                for (const rawCell of change.addedCells) {
                  const cell = MarimoNotebookCell.from(rawCell);
                  if (Option.isSome(cell.maybeId)) {
                    addedCellIds.add(cell.maybeId.value);
                  } else {
                    // Cell added from UI without a stableId (so we need to create one)
                    edits.push(
                      code.NotebookEdit.updateCellMetadata(
                        cell.index,
                        cell.buildEncodedMetadata({
                          overrides: { stableId: crypto.randomUUID() },
                        }),
                      ),
                    );
                  }
                }
              }

              if (edits.length > 0) {
                // add out cell ids from above
                const edit = new code.WorkspaceEdit();
                edit.set(event.notebook.uri, edits);
                yield* code.workspace.applyEdit(edit);
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
                const cell = MarimoNotebookCell.from(cellChange.cell);
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

                if (Option.isSome(cell.metadata) && !cell.isStale) {
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
            const notebook = Option.filterMap(
              yield* editorRegistry.getLastNotebookEditor(notebookUri),
              (e) => MarimoNotebookDocument.tryFrom(e.notebook),
            );

            if (Option.isNone(notebook)) {
              yield* Log.warn("Notebook not found for clearing stale", {
                notebookUri,
              });
              return;
            }

            const cell = notebook.value.cellAt(cellIndex);
            if (!cell) {
              yield* Log.warn("Cell not found", { notebookUri, cellIndex });
              return;
            }

            // Update cell metadata to remove stale state
            const edit = new code.WorkspaceEdit();
            const newMetadata = cell.buildEncodedMetadata({
              overrides: { state: undefined },
            });
            edit.set(notebook.value.uri, [
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
         * Stream of stale state changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
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
