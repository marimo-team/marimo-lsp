import { Option } from "effect";
import type * as vscode from "vscode";
import { MarimoNotebookCell, type NotebookCellId } from "../schemas.ts";
import type { Constants } from "../services/Constants.ts";
import { getCellExecutableCode } from "./getCellExecutableCode.ts";

export function extractExecuteCodeRequest(
  rawCells: Array<vscode.NotebookCell>,
  LanguageId: Constants["LanguageId"],
): Option.Option<{
  codes: Array<string>;
  cellIds: Array<NotebookCellId>;
}> {
  const codes: Array<string> = [];
  const cellIds: Array<NotebookCellId> = [];

  for (const rawCell of rawCells) {
    const cell = MarimoNotebookCell.from(rawCell);
    if (Option.isNone(cell.id)) {
      continue;
    }

    const code = getCellExecutableCode(cell, LanguageId);
    const cellId = cell.id.value;

    codes.push(code);
    cellIds.push(cellId);
  }

  if (codes.length === 0) {
    // no request
    Option.none();
  }

  return Option.some({ codes, cellIds });
}
