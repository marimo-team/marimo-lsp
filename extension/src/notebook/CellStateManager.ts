import { Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";

import { LanguageClient } from "../lsp/LanguageClient.ts";
import { VsCode } from "../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import type {
  NotebookCellId,
  NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import { NotebookEditorRegistry } from "./NotebookEditorRegistry.ts";

/**
 * Manages cell stale state across all notebooks.
 *
 * Tracks which cells have been edited (stale) and updates:
 * 1. VSCode context key "marimo.notebook.hasStaleCells" for UI enablement
 * 2. Backend about cell deletions
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

      // Track stale state: NotebookUri -> (CellId -> isStale)
      const staleStateRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, HashMap.HashMap<NotebookCellId, boolean>>(),
      );

      // Track last executed content: NotebookUri -> (CellId -> content)
      // Used to determine if undo restores content to last executed state
      const lastExecutedContentRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, HashMap.HashMap<NotebookCellId, string>>(),
      );

      // Helper to update context based on current state
      const updateContext = Effect.fn(function* () {
        const [staleMap, activeSerializedNotebook] = yield* Effect.all([
          SubscriptionRef.get(staleStateRef),
          editorRegistry.getActiveNotebookUri(),
        ]);

        // Check if the active marimo notebook has any stale cells
        const hasStaleCells = Option.match(activeSerializedNotebook, {
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
            Effect.fn(function* (event) {
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
                  if (Option.isSome(cell.id)) {
                    removedCellIds.add(cell.id.value);
                    removedCellsMap.set(cell.id.value, cell);
                  }
                }

                for (const rawCell of change.addedCells) {
                  const cell = MarimoNotebookCell.from(rawCell);
                  if (Option.isSome(cell.id)) {
                    addedCellIds.add(cell.id.value);
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
                yield* clearCellStaleTracking(event.notebook.id, cellId, {
                  staleStateRef,
                });

                // Clear last executed content
                yield* clearLastExecutedContent(event.notebook.id, cellId, {
                  lastExecutedContentRef,
                });

                // Notify backend about cell deletion
                yield* client
                  .executeCommand({
                    command: "marimo.api",
                    params: {
                      method: "delete-cell",
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
                          cellId,
                        }),
                      ),
                    ),
                  );
              }

              // Process cell changes (content or metadata edits)
              for (const cellChange of event.cellChanges) {
                const cell = MarimoNotebookCell.from(cellChange.cell);
                const cellId = cell.id;

                if (Option.isNone(cellId)) {
                  // Cell without an ID - skip stale tracking
                  continue;
                }

                // Check if document (content) changed
                if (cellChange.document) {
                  const currentContent = cell.document.getText();

                  // Check if content matches last executed (undo case)
                  const lastExecutedMap = yield* SubscriptionRef.get(
                    lastExecutedContentRef,
                  );
                  const lastExecutedContent = Option.flatMap(
                    HashMap.get(lastExecutedMap, event.notebook.id),
                    HashMap.get(cellId.value),
                  );

                  const shouldMarkStale = Option.match(lastExecutedContent, {
                    onNone: () => true, // No record = mark stale
                    onSome: (lastContent) => currentContent !== lastContent,
                  });

                  if (shouldMarkStale) {
                    yield* markCellStale(event.notebook.id, cellId.value, {
                      staleStateRef,
                    });
                  } else {
                    // Content matches last executed - clear stale state
                    yield* clearCellStaleWithMetadata(
                      event.notebook.id,
                      cellId.value,
                      {
                        staleStateRef,
                      },
                    );
                  }
                }

                // No metadata change
                if (!cellChange.metadata) {
                  continue;
                }

                if (Option.isSome(cell.metadata) && !cell.isStale) {
                  yield* clearCellStaleTracking(
                    event.notebook.id,
                    cellId.value,
                    {
                      staleStateRef,
                    },
                  );
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
        markCellStale(notebookUri: NotebookId, cellId: NotebookCellId) {
          return markCellStale(notebookUri, cellId, { staleStateRef });
        },

        /**
         * Clear stale state from a cell and store its content as last executed
         */
        clearCellStale(notebookUri: NotebookId, cellId: NotebookCellId) {
          return Effect.gen(function* () {
            const notebook = Option.filterMap(
              yield* editorRegistry.getLastNotebookEditor(notebookUri),
              (e) => MarimoNotebookDocument.tryFrom(e.notebook),
            );

            if (Option.isNone(notebook)) {
              yield* Effect.logWarning(
                "Notebook not found for clearing stale",
              ).pipe(Effect.annotateLogs({ notebookUri }));
              return;
            }

            const cell = notebook.value
              .getCells()
              .find((c) => Option.contains(c.id, cellId));
            if (!cell) {
              yield* Effect.logWarning("Cell not found").pipe(
                Effect.annotateLogs({ notebookUri, cellId }),
              );
              return;
            }

            // Store current content as last executed (cell is being run)
            const currentContent = cell.document.getText();
            yield* setLastExecutedContent(notebookUri, cellId, currentContent, {
              lastExecutedContentRef,
            });

            // Update tracking (no metadata write — see markCellStale comment)
            yield* clearCellStaleTracking(notebookUri, cellId, {
              staleStateRef,
            });
          });
        },

        /**
         * Check if a specific cell is stale
         */
        isCellStale(notebookUri: NotebookId, cellId: NotebookCellId) {
          return SubscriptionRef.get(staleStateRef).pipe(
            Effect.map((staleMap) =>
              HashMap.get(staleMap, notebookUri).pipe(
                Option.flatMap(HashMap.get(cellId)),
                Option.getOrElse(() => false),
              ),
            ),
          );
        },

        /**
         * Get all stale cell IDs for a notebook
         */
        getStaleCells(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const staleMap = yield* SubscriptionRef.get(staleStateRef);
            return HashMap.get(staleMap, notebookUri).pipe(
              Option.map((m) => Array.from(HashMap.keys(m))),
              Option.getOrElse(() => []),
            );
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
 * Mark a cell as stale in tracking.
 *
 * We intentionally do NOT write `state: "stale"` to cell metadata here
 * because `NotebookEdit.updateCellMetadata` always marks the notebook
 * dirty, even for transient fields. Stale state is tracked purely via
 * {@link staleStateRef} and communicated to the UI through its reactive
 * `changes` stream.
 */
function markCellStale(
  notebookUri: NotebookId,
  cellId: NotebookCellId,
  deps: {
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<NotebookCellId, boolean>>
    >;
  },
) {
  return SubscriptionRef.update(deps.staleStateRef, (map) => {
    const notebookMap = Option.getOrElse(HashMap.get(map, notebookUri), () =>
      HashMap.empty<NotebookCellId, boolean>(),
    );
    const updatedNotebookMap = HashMap.set(notebookMap, cellId, true);
    return HashMap.set(map, notebookUri, updatedNotebookMap);
  });
}

/**
 * Clear stale tracking for a cell (doesn't modify metadata)
 */
function clearCellStaleTracking(
  notebookUri: NotebookId,
  cellId: NotebookCellId,
  deps: {
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<NotebookCellId, boolean>>
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

      const updatedNotebookMap = HashMap.remove(notebookMap.value, cellId);
      if (HashMap.isEmpty(updatedNotebookMap)) {
        // Remove the notebook entry if no more stale cells
        return HashMap.remove(map, notebookUri);
      }

      return HashMap.set(map, notebookUri, updatedNotebookMap);
    });
  });
}

/**
 * Clear stale state from a cell (used when undo restores content)
 */
function clearCellStaleWithMetadata(
  notebookUri: NotebookId,
  cellId: NotebookCellId,
  deps: {
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<NotebookCellId, boolean>>
    >;
  },
) {
  return clearCellStaleTracking(notebookUri, cellId, deps);
}

/**
 * Store the last executed content for a cell
 */
function setLastExecutedContent(
  notebookUri: NotebookId,
  cellId: NotebookCellId,
  content: string,
  deps: {
    lastExecutedContentRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<NotebookCellId, string>>
    >;
  },
) {
  return Effect.gen(function* () {
    const { lastExecutedContentRef } = deps;

    yield* SubscriptionRef.update(lastExecutedContentRef, (map) => {
      const notebookMap = Option.getOrElse(HashMap.get(map, notebookUri), () =>
        HashMap.empty<NotebookCellId, string>(),
      );
      const updatedNotebookMap = HashMap.set(notebookMap, cellId, content);
      return HashMap.set(map, notebookUri, updatedNotebookMap);
    });
  });
}

/**
 * Clear last executed content for a cell (when deleted)
 */
function clearLastExecutedContent(
  notebookUri: NotebookId,
  cellId: NotebookCellId,
  deps: {
    lastExecutedContentRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookId, HashMap.HashMap<NotebookCellId, string>>
    >;
  },
) {
  return Effect.gen(function* () {
    const { lastExecutedContentRef } = deps;

    yield* SubscriptionRef.update(lastExecutedContentRef, (map) => {
      const notebookMap = HashMap.get(map, notebookUri);
      if (Option.isNone(notebookMap)) {
        return map;
      }

      const updatedNotebookMap = HashMap.remove(notebookMap.value, cellId);
      if (HashMap.isEmpty(updatedNotebookMap)) {
        return HashMap.remove(map, notebookUri);
      }

      return HashMap.set(map, notebookUri, updatedNotebookMap);
    });
  });
}
