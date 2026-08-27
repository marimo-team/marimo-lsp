import { type Context, Option } from "effect";
import type * as vscode from "vscode";

import type { Constants } from "../platform/Constants.ts";
import { MarimoNotebookCell } from "../schemas/MarimoNotebookDocument.ts";
import type { NotebookCellId } from "../schemas/MarimoNotebookDocument.ts";
import { getCellExecutableCode } from "./getCellExecutableCode.ts";

export function extractExecuteCodeRequest(
  rawCells: Array<vscode.NotebookCell>,
  LanguageId: Context.Service.Shape<typeof Constants>["LanguageId"],
): Option.Option<{
  cells: Array<{ cellId: NotebookCellId; code: string }>;
}> {
  const cells: Array<{ cellId: NotebookCellId; code: string }> = [];

  for (const rawCell of rawCells) {
    const cell = MarimoNotebookCell.from(rawCell);
    if (Option.isNone(cell.id)) {
      continue;
    }

    const code = getCellExecutableCode(cell, LanguageId);
    const cellId = cell.id.value;

    cells.push({ cellId, code });
  }

  if (cells.length === 0) {
    return Option.none();
  }

  return Option.some({ cells });
}
