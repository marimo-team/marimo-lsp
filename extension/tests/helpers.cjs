// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert");
const NodeFs = require("node:fs/promises");
const NodeOs = require("node:os");
const NodePath = require("node:path");
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
  NodeAssert.ok(ext, `Extension ${EXTENSION_ID} should be installed`);
  return ext;
}

async function activateExtension() {
  const ext = getExtension();
  if (!ext.isActive) {
    await ext.activate();
  }
  return ext;
}

/**
 * Creates a test context with an AsyncDisposableStack for temp-file cleanup.
 *
 * Only the context itself is `AsyncDisposable`. Notebooks returned by
 * `openNotebook` / `writeAndOpenNotebook` are plain `vscode.NotebookDocument`.
 *
 * Use at the top of a test:
 *
 *     await using ctx = createTestContext();
 *     const nb = await ctx.writeAndOpenNotebook();
 *     await selectKernel(nb);
 *     await runCell(nb.cellAt(0));
 *     assert.match(cellOutputText(nb.cellAt(0)), /10/);
 */
function createTestContext() {
  const stack = new AsyncDisposableStack();

  /**
   * Writes a source file to a fresh temp dir. Cleanup is deferred into the
   * context's stack.
   *
   * @param {string} [source]
   * @param {{ filename?: string }} [opts]
   * @returns {Promise<vscode.Uri>}
   */
  async function writeTempFile(source = DEFAULT_SOURCE, opts = {}) {
    const filename = opts.filename ?? "notebook.py";
    const dir = await NodeFs.mkdtemp(
      NodePath.join(NodeOs.tmpdir(), "marimo-it-"),
    );
    const filePath = NodePath.join(dir, filename);
    await NodeFs.writeFile(filePath, source, "utf8");
    stack.defer(async () => {
      await NodeFs.rm(dir, { recursive: true, force: true }).catch(() => {});
    });
    return vscode.Uri.file(filePath);
  }

  /**
   * Opens an existing .py file at `uri` as a marimo notebook.
   *
   * @param {vscode.Uri} uri
   * @returns {Promise<vscode.NotebookDocument>}
   */
  async function openNotebook(uri) {
    await activateExtension();
    const notebook = await vscode.workspace.openNotebookDocument(uri);
    NodeAssert.strictEqual(
      notebook.notebookType,
      NOTEBOOK_TYPE,
      `notebook opened as ${notebook.notebookType}, expected ${NOTEBOOK_TYPE}`,
    );
    return notebook;
  }

  /**
   * @param {string} [source]
   * @param {{ filename?: string }} [opts]
   * @returns {Promise<vscode.NotebookDocument>}
   */
  async function writeAndOpenNotebook(source, opts) {
    const uri = await writeTempFile(source, opts);
    return openNotebook(uri);
  }

  /**
   * Runs `fn` on each polling tick. Resolves when `fn` doesn't throw. Loops
   * forever — relies on mocha's `this.timeout(...)` to kill hung tests.
   *
   * The interval exists to yield to the event loop between polls so VS Code's
   * I/O callbacks can fire; it's not a delay.
   *
   * Side-effect-free predicates only: the callback is called many times.
   *
   * @param {() => void | Promise<void>} fn
   * @param {number} [interval]
   */
  async function waitUntil(fn, interval = 50) {
    while (true) {
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop: intentional polling
        await fn();
        return;
      } catch {
        // swallow and retry
      }
      // oxlint-disable-next-line eslint/no-await-in-loop: intentional polling
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
  }

  return {
    writeTempFile,
    openNotebook,
    writeAndOpenNotebook,
    waitUntil,
    async [Symbol.asyncDispose]() {
      await stack[Symbol.asyncDispose]();
    },
  };
}

/**
 * Binds the sandbox controller (or `id` override) to `notebook`, showing it
 * in an editor so VS Code will pick the kernel.
 *
 * @param {vscode.NotebookDocument} notebook
 * @param {string} [id]
 */
async function selectKernel(notebook, id = SANDBOX_CONTROLLER_ID) {
  const editor = await vscode.window.showNotebookDocument(notebook);
  await vscode.commands.executeCommand("notebook.selectKernel", {
    notebookEditor: editor,
    id,
    extension: EXTENSION_ID,
  });
  return editor;
}

/**
 * Triggers execution of `cell` and resolves once this cell's execution has
 * been finalized (`executionSummary.success !== undefined`). The subscription
 * is established before the command dispatches so we can't miss the event.
 *
 * Note: marimo's reactive model may trigger additional downstream cells when
 * this cell runs. Today we only wait for THIS cell to finalize; a future
 * improvement could wait for all triggered executions in the cascade to
 * settle (requires an extension-exposed "kernel idle" signal).
 *
 * @param {vscode.NotebookCell} cell
 */
async function runCell(cell) {
  const { notebook, index } = cell;
  const priorEndTime = cell.executionSummary?.timing?.endTime;

  /** @type {Promise<void>} */
  const finalized = new Promise((resolve) => {
    const sub = vscode.workspace.onDidChangeNotebookDocument((event) => {
      if (event.notebook.uri.toString() !== notebook.uri.toString()) return;
      for (const change of event.cellChanges) {
        if (change.cell.index !== index) continue;
        const summary = change.executionSummary;
        if (
          summary?.success !== undefined &&
          summary.timing?.endTime !== priorEndTime
        ) {
          sub.dispose();
          resolve();
          return;
        }
      }
    });
  });

  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: index, end: index + 1 }],
    document: notebook.uri,
  });
  await finalized;
}

/**
 * Replaces the entire text of a cell via WorkspaceEdit.
 *
 * @param {vscode.NotebookCell} cell
 * @param {string} newText
 */
async function editCell(cell, newText) {
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    cell.document.positionAt(0),
    cell.document.positionAt(cell.document.getText().length),
  );
  edit.replace(cell.document.uri, fullRange, newText);
  const applied = await vscode.workspace.applyEdit(edit);
  NodeAssert.ok(applied, "workspace.applyEdit should return true");
}

/**
 * Returns the concatenated utf-8 text of all output items on a cell.
 *
 * @param {vscode.NotebookCell} cell
 */
function cellOutputText(cell) {
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
  createTestContext,
  selectKernel,
  runCell,
  editCell,
  cellOutputText,
};
