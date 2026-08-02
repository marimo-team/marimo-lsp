import { Data, Effect, Option } from "effect";

import { VsCode } from "../platform/VsCode.ts";
import { type MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import * as Api from "../schemas/Models.gen.ts";

export type MarimoCellMetadataTransform = (
  current: Api.MarimoCellMetadata,
) => Api.MarimoCellMetadata;

export class CellMetadataEditRejected extends Data.TaggedError(
  "CellMetadataEditRejected",
)<{
  readonly cell: number;
}> {}

export class CellMetadataTargetNotFound extends Data.TaggedError(
  "CellMetadataTargetNotFound",
)<{
  readonly cell: number;
}> {}

function resolveCurrentCell(cell: MarimoNotebookCell) {
  const cells = cell.notebook.getCells();
  const identityIndex = cells.findIndex(
    (candidate) => candidate.rawNotebookCell === cell.rawNotebookCell,
  );
  if (identityIndex >= 0) {
    return { cell: cells[identityIndex], index: identityIndex } as const;
  }

  const matches = Option.match(cell.id, {
    onNone: () => [],
    onSome: (id) =>
      cells
        .map((candidate, index) => ({ candidate, index }))
        .filter(({ candidate }) =>
          Option.exists(candidate.id, (candidateId) => candidateId === id),
        ),
  });
  if (matches.length === 1) {
    return { cell: matches[0].candidate, index: matches[0].index } as const;
  }

  return new CellMetadataTargetNotFound({ cell: cell.index });
}

/**
 * Persist a marimo metadata change by replacing the cell while preserving its
 * text, language, outputs, runtime metadata, and foreign metadata.
 *
 * Cell replacement is intentional: the notebook LSP client currently treats
 * structural changes as its signal to resynchronize cell metadata.
 */
export const updateMarimoCellMetadata = Effect.fn(
  "notebook.updateMarimoCellMetadata",
)(function* (cell: MarimoNotebookCell, transform: MarimoCellMetadataTransform) {
  const code = yield* VsCode;
  const resolved = resolveCurrentCell(cell);
  if (resolved instanceof CellMetadataTargetNotFound) {
    return yield* resolved;
  }
  const currentCell = resolved.cell;
  const current = Option.match(currentCell.metadata, {
    onNone: () => Api.MarimoCellMetadata.make(),
    onSome: (metadata) => metadata.marimo,
  });

  const data = new code.NotebookCellData(
    currentCell.kind,
    currentCell.document.getText(),
    currentCell.document.languageId,
  );
  data.metadata = currentCell.buildMarimoMetadataUpdate(transform(current));
  data.outputs = currentCell.outputs.map(
    (output) =>
      new code.NotebookCellOutput(
        output.items.map(
          (item) => new code.NotebookCellOutputItem(item.data, item.mime),
        ),
        output.metadata,
      ),
  );
  data.executionSummary = currentCell.executionSummary;

  const edit = new code.WorkspaceEdit();
  edit.set(currentCell.notebook.uri, [
    code.NotebookEdit.replaceCells(
      new code.NotebookRange(resolved.index, resolved.index + 1),
      [data],
    ),
  ]);

  const applied = yield* code.workspace.applyEdit(edit);
  if (!applied) {
    return yield* new CellMetadataEditRejected({ cell: resolved.index });
  }
  return resolved.index;
});
