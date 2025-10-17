import { SQLParser } from "@marimo-team/smart-cells";
import type * as vscode from "vscode";

/**
 * Get the executable code for a cell, transforming SQL cells to Python mo.sql() wrapper
 */
export function getCellExecutableCode(cell: vscode.NotebookCell): string {
  // Transform SQL cells to Python mo.sql() wrapper
  if (cell.metadata?.language === "sql") {
    const sqlParser = new SQLParser();
    const languageMetadata = cell.metadata?.languageMetadata ?? {};
    const result = sqlParser.transformOut(
      cell.document.getText(),
      languageMetadata,
    );
    return result.code;
  }

  // Return Python cells as-is
  return cell.document.getText();
}
