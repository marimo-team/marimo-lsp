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
 * Tracks cell execution state to derive staleness.
 *
 * A cell is stale when its current code differs from what the kernel
 * last executed, or when it has never been executed. Staleness is
 * derived from a single piece of state per cell: the code that was
 * last sent to the kernel (`Option<string>`).
 *
 * - No entry → kernel hasn't seen this cell → not stale
 * - `None` → kernel invalidated (upstream dependency changed) → stale
 * - `Some(code)` → output reflects `code` → stale iff `code !== currentCode`
 *
 * Also handles cell deletion notifications to the backend and
 * stableId assignment for cells added from the UI.
 */
export class CellStateManager extends Effect.Service<CellStateManager>()(
  "CellStateManager",
  {
    dependencies: [NotebookEditorRegistry.Default],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const editorRegistry = yield* NotebookEditorRegistry;
      const client = yield* LanguageClient;

      // The only mutable state: what code the kernel last ran for each cell.
      // None = never executed or invalidated. Some(code) = output reflects code.
      const lastExecutedCodeRef = yield* SubscriptionRef.make(
        HashMap.empty<
          NotebookId,
          HashMap.HashMap<NotebookCellId, Option.Option<string>>
        >(),
      );

      /**
       * Derive whether any cell in the active notebook is stale.
       * Used to toggle the "Run Stale" toolbar button.
       */
      const updateContext = Effect.fn(function* () {
        const activeNotebook = yield* editorRegistry.getActiveNotebookUri();
        const hasStaleCells = yield* Option.match(activeNotebook, {
          onNone: () => Effect.succeed(false),
          onSome: (notebookUri) =>
            Effect.gen(function* () {
              const editor =
                yield* editorRegistry.getLastNotebookEditor(notebookUri);
              if (Option.isNone(editor)) return false;
              const notebook = MarimoNotebookDocument.tryFrom(
                editor.value.notebook,
              );
              if (Option.isNone(notebook)) return false;
              const cells = notebook.value.getCells();
              for (const cell of cells) {
                if (yield* isCellStale(cell, { lastExecutedCodeRef })) {
                  return true;
                }
              }
              return false;
            }),
        });

        yield* code.commands.setContext(
          "marimo.notebook.hasStaleCells",
          hasStaleCells,
        );
      });

      // Re-derive context when execution state changes
      yield* Effect.forkScoped(
        lastExecutedCodeRef.changes.pipe(
          Stream.mapEffect(updateContext),
          Stream.runDrain,
        ),
      );

      // Re-derive context when active notebook changes
      yield* Effect.forkScoped(
        editorRegistry
          .streamActiveNotebookChanges()
          .pipe(Stream.mapEffect(updateContext), Stream.runDrain),
      );

      // Re-derive context when cell content changes (staleness may flip)
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges().pipe(
          Stream.filter((event) => {
            if (Option.isNone(MarimoNotebookDocument.tryFrom(event.notebook))) {
              return false;
            }
            return event.cellChanges.some((c) => c.document !== undefined);
          }),
          Stream.mapEffect(updateContext),
          Stream.runDrain,
        ),
      );

      // Handle cell additions (stableId) and deletions (backend notification)
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
              const removedCellIds = new Set<NotebookCellId>();
              const addedCellIds = new Set<NotebookCellId>();
              const removedCellsMap = new Map<
                NotebookCellId,
                MarimoNotebookCell
              >();

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
                const edit = new code.WorkspaceEdit();
                edit.set(event.notebook.uri, edits);
                yield* code.workspace.applyEdit(edit);
              }

              // Process truly deleted cells (removed but not re-added as moves)
              const trulyDeletedCellIds = Array.from(removedCellIds).filter(
                (cellId) => !addedCellIds.has(cellId),
              );

              for (const cellId of trulyDeletedCellIds) {
                if (!removedCellsMap.has(cellId)) continue;

                // Clear execution tracking
                yield* SubscriptionRef.update(lastExecutedCodeRef, (map) => {
                  const notebookMap = HashMap.get(map, event.notebook.id);
                  if (Option.isNone(notebookMap)) {
                    return map;
                  }
                  const updated = HashMap.remove(notebookMap.value, cellId);
                  return HashMap.isEmpty(updated)
                    ? HashMap.remove(map, event.notebook.id)
                    : HashMap.set(map, event.notebook.id, updated);
                });

                // Notify backend
                yield* client
                  .executeCommand({
                    command: "marimo.api",
                    params: {
                      method: "delete-cell",
                      params: {
                        notebookUri: event.notebook.id,
                        inner: { cellId },
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
                          notebookUri: event.notebook.id,
                          cellId,
                        }),
                      ),
                    ),
                  );
              }
            }),
          ),
        ),
      );

      return {
        /**
         * Record that the kernel accepted this cell's code for execution.
         * Sets `lastExecutedCode = Some(currentCode)`, clearing stale state.
         */
        recordExecution(cell: MarimoNotebookCell) {
          const cellId = cell.id;
          if (Option.isNone(cellId)) {
            return Effect.void;
          }
          const notebookId = cell.notebook.id;
          const currentCode = cell.document.getText();
          return SubscriptionRef.update(lastExecutedCodeRef, (map) => {
            const notebookMap = Option.getOrElse(
              HashMap.get(map, notebookId),
              () => HashMap.empty<NotebookCellId, Option.Option<string>>(),
            );
            return HashMap.set(
              map,
              notebookId,
              HashMap.set(notebookMap, cellId.value, Option.some(currentCode)),
            );
          });
        },

        /**
         * Record that the kernel considers this cell's output stale
         * (e.g., upstream dependency changed). Sets `lastExecutedCode = None`.
         */
        invalidateCell(cell: MarimoNotebookCell) {
          const cellId = cell.id;
          if (Option.isNone(cellId)) return Effect.void;
          const notebookId = cell.notebook.id;
          return SubscriptionRef.update(lastExecutedCodeRef, (map) => {
            const notebookMap = Option.getOrElse(
              HashMap.get(map, notebookId),
              () => HashMap.empty<NotebookCellId, Option.Option<string>>(),
            );
            return HashMap.set(
              map,
              notebookId,
              HashMap.set(notebookMap, cellId.value, Option.none()),
            );
          });
        },

        /**
         * Check if a cell is stale.
         *
         * A cell is stale when:
         * - It has never been executed (`None`)
         * - Its code changed since last execution (`Some(old) !== current`)
         * - The kernel invalidated it via staleInputs (`None`)
         */
        isCellStale(cell: MarimoNotebookCell) {
          return isCellStale(cell, { lastExecutedCodeRef });
        },

        /**
         * Signal stream — emits when staleness may have changed.
         *
         * Fires on execution state changes AND content edits, since both
         * can flip a cell's stale status.
         */
        get changes(): Stream.Stream<void> {
          return Stream.merge(
            lastExecutedCodeRef.changes,
            code.workspace.notebookDocumentChanges().pipe(
              Stream.filter((event) => {
                const doc = MarimoNotebookDocument.tryFrom(event.notebook);
                if (Option.isNone(doc)) {
                  return false;
                }
                return event.cellChanges.some((c) => c.document !== undefined);
              }),
            ),
          );
        },
      };
    }),
  },
) {}

/**
 * Pure derivation: is this cell stale?
 */
function isCellStale(
  cell: MarimoNotebookCell,
  deps: {
    lastExecutedCodeRef: SubscriptionRef.SubscriptionRef<
      HashMap.HashMap<
        NotebookId,
        HashMap.HashMap<NotebookCellId, Option.Option<string>>
      >
    >;
  },
) {
  const cellId = cell.id;
  if (Option.isNone(cellId)) {
    return Effect.succeed(false);
  }
  const notebookId = cell.notebook.id;
  const currentCode = cell.document.getText();

  return SubscriptionRef.get(deps.lastExecutedCodeRef).pipe(
    Effect.map((map) => {
      // Look up this cell's entry in the execution map
      const entry = HashMap.get(map, notebookId).pipe(
        Option.flatMap(HashMap.get(cellId.value)),
      );
      // No entry → kernel hasn't seen this cell yet → not stale
      // Some(None) → kernel invalidated (staleInputs) → stale
      // Some(Some(code)) → stale iff code !== currentCode
      return Option.match(entry, {
        onNone: () => false,
        onSome: (lastExecutedCode) =>
          Option.match(lastExecutedCode, {
            onNone: () => true,
            onSome: (code) => code !== currentCode,
          }),
      });
    }),
  );
}
