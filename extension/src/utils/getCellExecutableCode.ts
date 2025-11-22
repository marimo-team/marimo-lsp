import { SQLParser } from "@marimo-team/smart-cells";
import { Option } from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import { PYTHON_LANGUAGE_ID, SQL_LANGUAGE_ID } from "../constants.ts";
import { decodeCellMetadata } from "../schemas.ts";

/**
 * Get the executable code for a cell, transforming SQL cells to Python mo.sql() wrapper
 */
export function getCellExecutableCode(cell: vscode.NotebookCell): string {
  const languageId = cell.document.languageId;
  const meta = decodeCellMetadata(cell.metadata);

  assert(
    cell.document.languageId === SQL_LANGUAGE_ID ||
      cell.document.languageId === PYTHON_LANGUAGE_ID,
    `Expected Python or SQL cell. Got "${languageId}".`,
  );

  // Transform SQL cells to Python mo.sql() wrapper
  if (languageId === SQL_LANGUAGE_ID) {
    const sqlParser = new SQLParser();
    const result = sqlParser.transformOut(
      cell.document.getText(),
      // Either stored on the cell, or we fallback to default ...
      meta.pipe(
        Option.flatMap((x) => Option.fromNullable(x.languageMetadata?.sql)),
        Option.getOrElse(() => sqlParser.defaultMetadata),
      ),
    );
    return result.code;
  }

  // Return Python cells as-is
  return cell.document.getText();
}
