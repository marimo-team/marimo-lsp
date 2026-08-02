import { Data, Effect, HashMap, Layer, Option, Ref, Stream } from "effect";

import { VsCode } from "../platform/VsCode.ts";
import {
  type MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
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

type HiddenCodeSnapshot = HashMap.HashMap<NotebookCellId, boolean>;

function snapshotHiddenCode(
  cells: readonly MarimoNotebookCell[],
): HiddenCodeSnapshot {
  let snapshot = HashMap.empty<NotebookCellId, boolean>();
  for (const cell of cells) {
    if (Option.isSome(cell.id)) {
      snapshot = HashMap.set(snapshot, cell.id.value, cell.isCodeHidden);
    }
  }
  return snapshot;
}

interface VisibilityChanges {
  readonly collapse: CellRange[];
  readonly expand: CellRange[];
}

type CellInputVisibilitySyncEvent = Data.TaggedEnum<{
  Synchronize: {
    readonly notebook: MarimoNotebookDocument;
    readonly initialize: boolean;
  };
  Close: { readonly notebookId: NotebookId };
}>;
const CellInputVisibilitySyncEvent =
  Data.taggedEnum<CellInputVisibilitySyncEvent>();

function visibilityChanges(
  previous: Option.Option<HiddenCodeSnapshot>,
  cells: readonly MarimoNotebookCell[],
): VisibilityChanges {
  if (Option.isNone(previous)) {
    return { collapse: hiddenInputCellRanges(cells), expand: [] };
  }

  const collapse: CellRange[] = [];
  const expand: CellRange[] = [];
  for (const cell of cells) {
    if (Option.isNone(cell.id)) continue;

    const before = HashMap.get(previous.value, cell.id.value);
    const range = { start: cell.index, end: cell.index + 1 };
    if (cell.isCodeHidden && !Option.getOrElse(before, () => false)) {
      collapse.push(range);
    } else if (!cell.isCodeHidden && Option.isSome(before) && before.value) {
      expand.push(range);
    }
  }
  return { collapse, expand };
}

/**
 * Keeps cell input visibility synchronized with persisted `hide_code` metadata.
 *
 * VS Code exposes the input-collapsed state as view-only: we can neither read
 * it nor set it through cell metadata, only fire `notebook.cell.collapseCellInput`.
 * So this is a one-way sync, not a binding. We collapse a notebook's hidden
 * cells when it first becomes active, then compare metadata snapshots by stable
 * cell ID and apply only `hide_code` transitions. Refocusing and unrelated
 * edits therefore do not override a user's temporary manual expansion.
 */
export const CellInputVisibilitySyncLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;

    const snapshots = yield* Ref.make(
      HashMap.empty<NotebookId, HiddenCodeSnapshot>(),
    );

    const synchronize = Effect.fn("CellInputVisibilitySync.synchronize")(
      function* (notebook: MarimoNotebookDocument, initialize: boolean) {
        const previous = HashMap.get(yield* Ref.get(snapshots), notebook.id);
        if (!initialize && Option.isNone(previous)) return;

        const cells = notebook.getCells();
        const changes = visibilityChanges(previous, cells);
        const next = snapshotHiddenCode(cells);

        yield* Effect.annotateCurrentSpan({
          notebook: notebook.id,
          collapsedCells: changes.collapse.length,
          expandedCells: changes.expand.length,
        });

        const apply = (
          command:
            | "notebook.cell.collapseCellInput"
            | "notebook.cell.expandCellInput",
          ranges: readonly CellRange[],
        ) =>
          ranges.length === 0
            ? Effect.void
            : code.commands.executeVSCode(command, {
                ranges,
                document: notebook.uri,
              });

        yield* apply("notebook.cell.collapseCellInput", changes.collapse);
        yield* apply("notebook.cell.expandCellInput", changes.expand);
        yield* Ref.update(snapshots, HashMap.set(notebook.id, next));
      },
    );

    const synchronizeSafely = (
      notebook: MarimoNotebookDocument,
      initialize: boolean,
    ) =>
      synchronize(notebook, initialize).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning("Failed to synchronize hidden cell inputs").pipe(
            Effect.annotateLogs({ error, notebook: notebook.id }),
          ),
        ),
      );

    // Prepend the currently-active editor: onDidChangeActiveNotebookEditor
    // only emits future changes, so this covers a notebook open at startup.
    const activations = Stream.concat(
      Stream.fromEffect(code.window.getActiveNotebookEditor()),
      code.window.activeNotebookEditorChanges(),
    ).pipe(
      Stream.filterMap((editor) =>
        Option.filterMap(editor, (editor) =>
          MarimoNotebookDocument.tryFrom(editor.notebook),
        ),
      ),
      Stream.map(
        (notebook): CellInputVisibilitySyncEvent =>
          CellInputVisibilitySyncEvent.Synchronize({
            notebook,
            initialize: true,
          }),
      ),
    );

    const changes = code.workspace.notebookDocumentChanges().pipe(
      Stream.filterMap((event) =>
        MarimoNotebookDocument.tryFrom(event.notebook),
      ),
      Stream.map(
        (notebook): CellInputVisibilitySyncEvent =>
          CellInputVisibilitySyncEvent.Synchronize({
            notebook,
            initialize: false,
          }),
      ),
    );

    const closures = code.workspace.notebookDocumentClosed().pipe(
      Stream.filterMap((notebook) => MarimoNotebookDocument.tryFrom(notebook)),
      Stream.map(
        (notebook): CellInputVisibilitySyncEvent =>
          CellInputVisibilitySyncEvent.Close({ notebookId: notebook.id }),
      ),
    );

    // A single consumer serializes activation, document-change, and close state.
    yield* Effect.forkScoped(
      Stream.mergeAll([activations, changes, closures], {
        concurrency: "unbounded",
      }).pipe(
        Stream.runForEach((event) =>
          CellInputVisibilitySyncEvent.$match(event, {
            Close: ({ notebookId }) =>
              Ref.update(snapshots, HashMap.remove(notebookId)),
            Synchronize: ({ notebook, initialize }) =>
              synchronizeSafely(notebook, initialize),
          }),
        ),
      ),
    );
  }),
);
