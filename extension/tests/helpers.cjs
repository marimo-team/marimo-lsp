// @ts-check
/// <reference types="mocha" />

const assert = require("node:assert");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vscode = require("vscode");

const EXTENSION_ID = "marimo-team.vscode-marimo";
const NOTEBOOK_TYPE = "marimo-notebook";
const SANDBOX_CONTROLLER_ID = "marimo-sandbox";

const DEFAULT_SOURCE = `# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
# ]
# ///

import marimo

app = marimo.App()


@app.cell
def _():
    print(10)
    return


if __name__ == "__main__":
    app.run()
`;

function getExtension() {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  assert.ok(ext, `Extension ${EXTENSION_ID} should be installed`);
  return ext;
}

async function activateExtension() {
  const ext = getExtension();
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext;
}

async function getMarimoApi() {
  const ext = await activateExtension();
  return /** @type {import("../src/platform/Api.ts").MarimoApi} */ (
    ext.exports
  );
}

/**
 * Writes a .py source to a fresh temp directory on disk. Returns the URI and
 * a cleanup fn that removes the directory.
 *
 * @param {object} [options]
 * @param {string} [options.source]
 * @param {string} [options.filename]
 */
async function writeTempNotebook(options = {}) {
  const source = options.source ?? DEFAULT_SOURCE;
  const filename = options.filename ?? "notebook.py";
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "marimo-it-"));
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, source, "utf8");
  const uri = vscode.Uri.file(filePath);
  return {
    uri,
    dir,
    cleanup: async () => {
      try {
        await fs.rm(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

/**
 * @param {vscode.Uri} uri
 */
async function openMarimoNotebook(uri) {
  await activateExtension();
  const notebook = await vscode.workspace.openNotebookDocument(uri);
  assert.strictEqual(
    notebook.notebookType,
    NOTEBOOK_TYPE,
    `notebook opened as ${notebook.notebookType}, expected ${NOTEBOOK_TYPE}`,
  );
  return notebook;
}

/**
 * Shows the notebook and binds the sandbox controller to it.
 *
 * @param {vscode.NotebookDocument} notebook
 */
async function selectSandboxController(notebook) {
  const editor = await vscode.window.showNotebookDocument(notebook);
  await vscode.commands.executeCommand("notebook.selectKernel", {
    notebookEditor: editor,
    id: SANDBOX_CONTROLLER_ID,
    extension: EXTENSION_ID,
  });
  return editor;
}

/**
 * Replaces the entire text of a cell via WorkspaceEdit.
 *
 * @param {vscode.NotebookDocument} notebook
 * @param {number} index
 * @param {string} newText
 */
async function editCellText(notebook, index, newText) {
  const cell = notebook.cellAt(index);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    cell.document.positionAt(0),
    cell.document.positionAt(cell.document.getText().length),
  );
  edit.replace(cell.document.uri, fullRange, newText);
  const applied = await vscode.workspace.applyEdit(edit);
  assert.ok(applied, "workspace.applyEdit should return true");
}

/**
 * Runs a single cell and resolves when execution has completed (success or
 * failure). Rejects on timeout.
 *
 * @param {vscode.NotebookDocument} notebook
 * @param {number} index
 * @param {number} [timeoutMs]
 * @returns {Promise<vscode.NotebookCellExecutionSummary>}
 */
async function runCell(notebook, index, timeoutMs = 90_000) {
  const targetCell = notebook.cellAt(index);

  /** @type {Promise<vscode.NotebookCellExecutionSummary>} */
  const completed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      sub.dispose();
      reject(new Error(`runCell(${index}) timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const sub = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return;
      for (const change of event.cellChanges) {
        if (change.cell !== targetCell) continue;
        const summary = change.executionSummary;
        if (summary && summary.success !== undefined) {
          clearTimeout(timer);
          sub.dispose();
          resolve(summary);
          return;
        }
      }
    });
  });

  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: index, end: index + 1 }],
    document: notebook.uri,
  });

  return completed;
}

/**
 * Returns the concatenated utf-8 text of all output items on a cell.
 *
 * @param {vscode.NotebookCell} cell
 */
function getCellOutputText(cell) {
  const decoder = new TextDecoder();
  const parts = [];
  for (const output of cell.outputs) {
    for (const item of output.items) {
      parts.push(decoder.decode(item.data));
    }
  }
  return parts.join("");
}

module.exports = {
  EXTENSION_ID,
  NOTEBOOK_TYPE,
  SANDBOX_CONTROLLER_ID,
  DEFAULT_SOURCE,
  getExtension,
  activateExtension,
  getMarimoApi,
  writeTempNotebook,
  openMarimoNotebook,
  selectSandboxController,
  editCellText,
  runCell,
  getCellOutputText,
};
