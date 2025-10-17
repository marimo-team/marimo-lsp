import type { Brand } from "effect";
import type * as vscode from "vscode";

export type MarimoNotebookDocument = Brand.Branded<
  vscode.NotebookDocument,
  "MarimoNotebookDocument"
>;
