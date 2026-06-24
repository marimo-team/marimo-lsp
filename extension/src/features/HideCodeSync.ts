import { Effect, HashSet, Layer, Option, Ref, Stream } from "effect";

import { VsCode } from "../platform/VsCode.ts";
import {
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";

/**
 * A contiguous, end-exclusive range of cells, addressed by index.
 *
 * This matches VS Code's `ICellRange`, the shape `notebook.cell.collapseCellInput`
 * accepts to pick which cells to act on.
 */
export interface CellRange {
  readonly start: number;
  readonly end: number;
}

/**
 * Returns one single-cell range per `hide_code` cell, in document order.
 *
 * It is a plain function rather than part of the layer below so the selection
 * logic can be tested without standing up a notebook editor.
 */
export function hiddenInputCellRanges(
  cells: readonly MarimoNotebookCell[],
): CellRange[] {
  return cells
    .filter((cell) => cell.isCodeHidden)
    .map((cell) => ({ start: cell.index, end: cell.index + 1 }));
}

/**
 * Collapses the code input of `hide_code` cells when a marimo notebook opens.
 *
 * VS Code exposes the input-collapsed state as view-only: we can neither read
 * it nor set it through cell metadata, only fire `notebook.cell.collapseCellInput`.
 * So this is a one-way sync, not a binding. We collapse a notebook's `hide_code`
 * cells the first time it becomes active and track it per session, so refocusing
 * the tab does not re-hide a cell the user expanded to edit. See issue #326.
 */
export const HideCodeSyncLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;

    // Notebooks already collapsed this session; refocusing a tab must not
    // re-hide a cell the user has since expanded.
    const collapsed = yield* Ref.make(HashSet.empty<NotebookId>());

    yield* Effect.forkScoped(
      // Prepend the currently-active editor: onDidChangeActiveNotebookEditor
      // only emits future changes, so this covers a notebook open at startup.
      Stream.concat(
        Stream.fromEffect(code.window.getActiveNotebookEditor()),
        code.window.activeNotebookEditorChanges(),
      ).pipe(
        Stream.runForEach(
          Effect.fn("HideCodeSync.collapseHiddenCells")(function* (editor) {
            const notebook = Option.filterMap(editor, (editor) =>
              MarimoNotebookDocument.tryFrom(editor.notebook),
            );
            if (Option.isNone(notebook)) {
              return;
            }

            const id = notebook.value.id;
            if (HashSet.has(yield* Ref.get(collapsed), id)) {
              return;
            }

            const ranges = hiddenInputCellRanges(notebook.value.getCells());
            if (ranges.length === 0) {
              return;
            }

            yield* Effect.annotateCurrentSpan({
              notebook: id,
              hiddenCells: ranges.length,
            });

            yield* code.commands
              .executeCommand("notebook.cell.collapseCellInput", {
                ranges,
                document: notebook.value.uri,
              })
              .pipe(
                // Mark only after a successful collapse, so a transient failure
                // retries on the next activation.
                Effect.andThen(Ref.update(collapsed, HashSet.add(id))),
                Effect.catchAll((error) =>
                  Effect.logWarning("Failed to collapse hidden cells").pipe(
                    Effect.annotateLogs({ error }),
                  ),
                ),
              );
          }),
        ),
      ),
    );
  }),
);
