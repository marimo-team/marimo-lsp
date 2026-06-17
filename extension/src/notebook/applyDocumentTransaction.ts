/**
 * Replay a kernel document transaction onto the VS Code notebook.
 *
 * The kernel (code mode, file-watch, …) owns the dataflow graph; VS Code owns
 * the document. When the kernel emits a transaction we reflect it here by
 * diffing the desired cell list against the current one and applying the
 * minimal `replaceCells`, carrying each surviving cell's outputs forward by
 * `stableId` (== marimo's `CellId`) so a reorder or edit doesn't
 * drop rendered output. See {@link computeDesiredCells} / {@link diffToReplaceRange}.
 */

import { Effect, Option } from "effect";

import { Constants } from "../platform/Constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { CellMetadata } from "../schemas/CellMetadata.ts";
import { encodeCellMetadata } from "../schemas/CellMetadata.ts";
import type {
  MarimoNotebookCell,
  MarimoNotebookDocument,
} from "../schemas/MarimoNotebookDocument.ts";
import type { DocumentTransactionNotification } from "../types.ts";
import {
  computeDesiredCells,
  diffToReplaceRange,
  type PlanCell,
} from "./transactionPlan.ts";

/** Project a live VS Code cell into the planner's view; `null` if it has no stableId. */
function toPlanCell(cell: MarimoNotebookCell): Option.Option<PlanCell> {
  const stableId = Option.getOrNull(cell.stableId);
  if (stableId == null) {
    return Option.none();
  }
  const options = Option.match(cell.metadata, {
    onNone: (): Record<string, unknown> => ({}),
    onSome: (meta) => meta.options ?? {},
  });
  const languageMetadata = Option.match(cell.metadata, {
    onNone: () => undefined,
    onSome: (meta) => meta.languageMetadata,
  });
  return Option.some({
    stableId,
    code: cell.document.getText(),
    languageId: cell.document.languageId,
    kind: cell.kind,
    name: Option.getOrElse(cell.name, () => ""),
    config: {
      column: typeof options.column === "number" ? options.column : null,
      disabled: options.disabled === true,
      hide_code: options.hide_code === true,
    },
    languageMetadata,
  });
}

export const applyDocumentTransaction = Effect.fn(
  "notebook.applyDocumentTransaction",
)(function* (
  notebook: MarimoNotebookDocument,
  transaction: DocumentTransactionNotification["transaction"],
) {
  const code = yield* VsCode;
  const { LanguageId } = yield* Constants;

  const byId = new Map<string, MarimoNotebookCell>();
  const current: PlanCell[] = [];
  for (const cell of notebook.getCells()) {
    const plan = toPlanCell(cell);
    if (Option.isSome(plan)) {
      current.push(plan.value);
      byId.set(plan.value.stableId, cell);
    }
  }

  const desired = computeDesiredCells(current, transaction.changes, LanguageId);
  const range = diffToReplaceRange(current, desired);
  if (range == null) return;

  const cells = range.cells.map((cell) => {
    const data = new code.NotebookCellData(
      cell.kind,
      cell.code,
      cell.languageId,
    );
    const existing = byId.get(cell.stableId);

    // Carry outputs forward by stableId. Fresh output instances: VS Code's
    // model skips re-render for same-identity outputs (see NotebookSerializer's
    // snapshotLiveNotebook), so we reconstruct them.
    data.outputs = existing
      ? existing.outputs.map(
          (out) =>
            new code.NotebookCellOutput(
              out.items.map(
                (item) => new code.NotebookCellOutputItem(item.data, item.mime),
              ),
              out.metadata,
            ),
        )
      : [];

    // Preserve a surviving cell's other metadata (e.g. state); override the
    // fields the transaction owns. `languageMetadata` is owned by the
    // classification so a promote/demote overwrites (or clears) the prior value.
    const base = existing
      ? Option.getOrElse(existing.metadata, (): CellMetadata => ({}))
      : {};
    data.metadata = encodeCellMetadata({
      ...base,
      stableId: cell.stableId,
      name: cell.name === "" ? undefined : cell.name,
      options: cell.config,
      languageMetadata: cell.languageMetadata,
    });

    return data;
  });

  const edit = new code.WorkspaceEdit();
  edit.set(notebook.uri, [
    code.NotebookEdit.replaceCells(
      new code.NotebookRange(range.start, range.start + range.deleteCount),
      cells,
    ),
  ]);
  yield* code.workspace.applyEdit(edit);

  yield* Effect.logInfo("Applied document transaction").pipe(
    Effect.annotateLogs({
      notebook: notebook.id,
      source: transaction.source,
      start: range.start,
      replaced: range.deleteCount,
      inserted: range.cells.length,
    }),
  );
});
