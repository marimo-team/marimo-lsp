import * as vscode from "vscode";

export const Config = {
  get lspPath(): string[] {
    return vscode.workspace.getConfiguration("marimo.lsp").get<string[]>("path", []) ?? [];
  },
};
