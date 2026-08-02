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
  const current = Option.match(cell.metadata, {
    onNone: () => Api.MarimoCellMetadata.make(),
    onSome: (metadata) => metadata.marimo,
  });

  const data = new code.NotebookCellData(
    cell.kind,
    cell.document.getText(),
    cell.document.languageId,
  );
  data.metadata = cell.buildMarimoMetadataUpdate(transform(current));
  data.outputs = cell.outputs.map(
    (output) =>
      new code.NotebookCellOutput(
        output.items.map(
          (item) => new code.NotebookCellOutputItem(item.data, item.mime),
        ),
        output.metadata,
      ),
  );
  data.executionSummary = cell.executionSummary;

  const edit = new code.WorkspaceEdit();
  edit.set(cell.notebook.uri, [
    code.NotebookEdit.replaceCells(
      new code.NotebookRange(cell.index, cell.index + 1),
      [data],
    ),
  ]);

  const applied = yield* code.workspace.applyEdit(edit);
  if (!applied) {
    return yield* new CellMetadataEditRejected({ cell: cell.index });
  }
  return undefined;
});
