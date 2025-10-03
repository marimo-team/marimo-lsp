import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import type { MarimoNotebookDocument } from "../services/NotebookSerializer.ts";

export function isMarimoNotebookDocument(
  notebook: vscode.NotebookDocument,
): notebook is MarimoNotebookDocument {
  return notebook.notebookType === NOTEBOOK_TYPE;
}
