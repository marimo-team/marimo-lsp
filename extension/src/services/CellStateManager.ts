import { Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";
import { ContextKeys } from "../constants.ts";
import { decodeCellMetadata, encodeCellMetadata } from "../schemas.ts";
import { getNotebookUri, type NotebookUri } from "../types.ts";
import { Log } from "../utils/log.ts";
import { isMarimoNotebookDocument } from "../utils/notebook.ts";
import { NotebookEditorRegistry } from "./NotebookEditorRegistry.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Manages cell stale state across all notebooks.
 *
 * Tracks which cells have been edited (stale) and updates:
 * 1. Cell metadata with state: "stale"
 * 2. VSCode context key "marimo.hasStaleCells" for UI enablement
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

      // Track stale state: NotebookUri -> (CellIndex -> isStale)
      const staleStateRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookUri, HashMap.HashMap<number, boolean>>(),
      );

      // Helper to update context based on current state
      const updateContext = Effect.fnUntraced(function* () {
        const staleMap = yield* SubscriptionRef.get(staleStateRef);
        const activeMarimoNotebook =
          yield* editorRegistry.getActiveNotebookUri();

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

        yield* code.commands.executeCommand(
          "setContext",
          ContextKeys["marimo.hasStaleCells"],
          hasStaleCells,
        );
        yield* Log.debug("Updated stale context", { hasStaleCells });
      });

      // Set initial context state
      yield* Effect.forkScoped(updateContext());

      // Subscribe to stale state changes to update VSCode context
      yield* Effect.forkScoped(
        Stream.changes(staleStateRef).pipe(
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
          Stream.mapEffect(
            Effect.fnUntraced(function* (event) {
              yield* Effect.logTrace("onDidChangeNotebookDocument", event);

              // Only process marimo notebooks
              if (!isMarimoNotebookDocument(event.notebook)) {
                return;
              }

              const notebookUri = getNotebookUri(event.notebook);

              // Process cell changes (content or metadata edits)
              for (const cellChange of event.cellChanges) {
                const cell = cellChange.cell;
                const cellIndex = cell.index;

                // Check if document (content) changed
                if (cellChange.document) {
                  yield* Log.trace("Cell content changed", {
                    notebookUri,
                    cellIndex,
                  });

                  // Mark cell as stale
                  yield* markCellStale(notebookUri, cellIndex, {
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
                  yield* clearCellStaleTracking(notebookUri, cellIndex, {
                    staleStateRef,
                  });
                }
              }
            }),
          ),
          Stream.runDrain,
        ),
      );

      return {
        /**
         * Mark a cell as stale and update its metadata
         */
        markCellStale(notebookUri: NotebookUri, cellIndex: number) {
          return Effect.gen(function* () {
            const notebook =
              yield* editorRegistry.getLastNotebookEditor(notebookUri);

            if (Option.isNone(notebook)) {
              yield* Log.warn("Notebook not found", { notebookUri });
              return;
            }

            yield* markCellStale(notebookUri, cellIndex, {
              code,
              staleStateRef,
              notebook: notebook.value.notebook,
            });
          });
        },

        /**
         * Clear stale state from a cell
         */
        clearCellStale(notebookUri: NotebookUri, cellIndex: number) {
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
        getStaleCells(notebookUri: NotebookUri) {
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
          return Stream.changes(staleStateRef);
        },
      };
    }),
  },
) {}

/**
 * Mark a cell as stale in tracking and metadata
 */
function markCellStale(
  notebookUri: NotebookUri,
  cellIndex: number,
  deps: {
    code: VsCode;
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookUri, HashMap.HashMap<number, boolean>>
    >;
    notebook: vscode.NotebookDocument;
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
    const newMetadata = encodeCellMetadata({
      ...cell.metadata,
      state: "stale",
    });
    edit.set(notebook.uri, [
      code.NotebookEdit.updateCellMetadata(cellIndex, newMetadata),
    ]);
    yield* code.workspace.applyEdit(edit);

    yield* Log.trace("Marked cell as stale", { notebookUri, cellIndex });
  });
}

/**
 * Clear stale tracking for a cell (doesn't modify metadata)
 */
function clearCellStaleTracking(
  notebookUri: NotebookUri,
  cellIndex: number,
  deps: {
    staleStateRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<NotebookUri, HashMap.HashMap<number, boolean>>
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
