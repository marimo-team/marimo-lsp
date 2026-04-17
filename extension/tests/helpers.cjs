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

async function getMarimoApi() {
  const ext = await activateExtension();
  return /** @type {import("../src/platform/Api.ts").MarimoApi} */ (
    ext.exports
  );
}

/**
 * Creates a test context with a shared AbortSignal and AsyncDisposableStack.
 *
 * Only the context itself is `AsyncDisposable`. Notebooks returned by
 * `openNotebook` / `writeAndOpenNotebook` are plain `vscode.NotebookDocument`
 * — the context owns their lifetimes (temp dirs, etc.) via its stack.
 *
 * Use at the top of a test:
 *
 *     await using ctx = createTestContext({ timeoutMs: 170_000 });
 *     const nb = await ctx.writeAndOpenNotebook();
 *     await selectKernel(nb);
 *     await runCell(nb.cellAt(0));
 *     await ctx.waitUntil(() => assert.match(cellOutputText(nb.cellAt(0)), /10/));
 *
 * @param {{ timeoutMs?: number, signal?: AbortSignal }} [options]
 */
function createTestContext(options = {}) {
  const stack = new AsyncDisposableStack();
  const signals = [];
  if (options.signal) signals.push(options.signal);
  if (options.timeoutMs != null)
    signals.push(AbortSignal.timeout(options.timeoutMs));
  const signal =
    signals.length === 0
      ? new AbortController().signal
      : signals.length === 1
        ? signals[0]
        : AbortSignal.any(signals);

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
   * Runs `fn` on each polling interval. If `fn` returns/resolves, `waitUntil`
   * resolves. If `fn` throws, the error is swallowed and retried. When the
   * context's signal aborts, the most recent thrown error is re-raised — so
   * timeouts report the real assertion failure, not a generic "timeout".
   *
   * Side-effect-free predicates only: the callback is called many times.
   *
   * @param {() => void | Promise<void>} fn
   * @param {{ intervalMs?: number }} [opts]
   */
  async function waitUntil(fn, opts = {}) {
    const { intervalMs = 50 } = opts;
    /** @type {unknown} */
    let lastError;
    while (true) {
      if (signal.aborted) {
        throw lastError ?? signal.reason ?? new Error("waitUntil aborted");
      }
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop: intentional polling
        await fn();
        return;
      } catch (err) {
        lastError = err;
      }
      // oxlint-disable-next-line eslint/no-await-in-loop: intentional polling
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        const onAbort = () => {
          clearTimeout(timer);
          resolve(undefined);
        };
        if (signal.aborted) {
          onAbort();
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
      });
    }
  }

  return {
    signal,
    stack,
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
 * Triggers execution of a cell. Does not wait for completion — callers should
 * follow up with `ctx.waitUntil(() => assert.match(cellOutputText(cell), ...))`.
 *
 * @param {vscode.NotebookCell} cell
 */
async function runCell(cell) {
  const { notebook, index } = cell;
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: index, end: index + 1 }],
    document: notebook.uri,
  });
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
  EXTENSION_ID,
  NOTEBOOK_TYPE,
  SANDBOX_CONTROLLER_ID,
  DEFAULT_SOURCE,
  getExtension,
  activateExtension,
  getMarimoApi,
  createTestContext,
  selectKernel,
  runCell,
  editCell,
  cellOutputText,
};
