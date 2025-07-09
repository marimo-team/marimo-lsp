import * as vscode from "vscode";
import * as lsp from "vscode-languageclient";

import { Logger } from "./logging.ts";
import { MarimoNotebookSerializer } from "./notebookSerializer.ts";
import { executeCommand } from "./commands.ts";

/**
 * Marimo Notebook Controller
 *
 * Provides kernel execution capabilities for marimo notebooks
 */
export class KernelManager implements vscode.Disposable {
  public readonly controller: vscode.NotebookController;

  constructor(client: lsp.BaseLanguageClient) {
    this.controller = vscode.notebooks.createNotebookController(
      "marimo-lsp-controller",
      MarimoNotebookSerializer.notebookType,
      "marimo kernel",
      async (cells, notebookDocument) => {
        Logger.debug("KernelManager", "executeHandler");
        Logger.trace("KernelManager", "executeHandler", {
          cells,
          notebookDocument,
        });
        await executeCommand(client, {
          command: "marimo.run",
          params: {
            notebookUri: notebookDocument.uri.toString(),
            cellIds: cells.map((cell) => getCellId(cell)),
            codes: cells.map((cell) => cell.document.getText()),
          },
        });
      },
    );
  }

  public dispose() {
    this.controller.dispose();
  }
}

/**
 * Simple approach: While the notebook is open in the current VS Code session,
 * each cell's ID can be taken from the URI fragment (`...#<cellId>`).
 *
 * This works as long as the notebook's document URI doesn't change—
 * e.g., saving "Untitled-1.py" as "foo_mo.py" resets the session and cell IDs.
 */
function getCellId(cell: vscode.NotebookCell): string {
  return decodeURIComponent(cell.document.uri.toString().split("#")[1]);
}
