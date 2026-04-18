// @ts-check
/// <reference types="mocha" />

// Integration coverage for the LSP surface across marimo cells:
// 1. ty (managed language server) provides hover/type info on cell symbols
// 2. marimo-lsp emits `multiple-definitions` diagnostics when two cells
//    define the same top-level name
//
// These are end-to-end wire tests — they verify the full path from VS Code
// event → LSP client → LSP server → diagnostic collection / hover provider.

const NodeAssert = require("node:assert");
const vscode = require("vscode");

const { createTestContext, selectKernel } = require("./helpers.cjs");

const SCRIPT_HEADER = `# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
# ]
# ///

import marimo

app = marimo.App()
`;

const SCRIPT_FOOTER = `

if __name__ == "__main__":
    app.run()
`;

/**
 * Build marimo notebook source from an array of cell body strings. Each
 * body is wrapped in `@app.cell / def _(): / return`.
 *
 * @param {string[]} bodies
 */
function makeSource(bodies) {
  const blocks = bodies.map((body) => {
    const indented = body
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n");
    return `\n\n@app.cell\ndef _():\n${indented}\n    return\n`;
  });
  return SCRIPT_HEADER + blocks.join("") + SCRIPT_FOOTER;
}

/**
 * @param {readonly vscode.Diagnostic[]} diags
 */
function marimoMultiDef(diags) {
  return diags.filter(
    (d) => d.source === "marimo" && d.code === "multiple-definitions",
  );
}

suite("diagnostics", function () {
  this.timeout(8_000);

  test("ty resolves cross-cell type in any order; adding a redefinition triggers marimo multiple-definitions", async function () {
    await using ctx = createTestContext();
    // Three cells: `a` (reference), `a = 10` (definition), `a` (reference).
    // Regardless of physical cell order, ty should see the whole notebook
    // in topological order and infer Literal[10] for both references.
    const nb = await ctx.writeAndOpenNotebook(makeSource(["a", "a = 10", "a"]));
    await selectKernel(nb);

    NodeAssert.strictEqual(nb.cellCount, 3);

    /** Hover at (0,0) of a cell and return the joined contents as a string. */
    async function hoverText(cell) {
      const hovers = /** @type {vscode.Hover[] | undefined} */ (
        await vscode.commands.executeCommand(
          "vscode.executeHoverProvider",
          cell.document.uri,
          new vscode.Position(0, 0),
        )
      );
      if (!Array.isArray(hovers) || hovers.length === 0) return "";
      return hovers
        .flatMap((h) =>
          h.contents.map((c) => (typeof c === "string" ? c : c.value)),
        )
        .join("\n");
    }

    // Every `a` occurrence (cells 0 and 2) should resolve to Literal[10].
    for (const idx of [0, 2]) {
      // oxlint-disable-next-line eslint/no-await-in-loop: poll each cell serially
      await ctx.waitUntil(async () => {
        const text = await hoverText(nb.cellAt(idx));
        NodeAssert.match(
          text,
          /Literal\[10\]/,
          `cell ${idx} should hover as Literal[10], got: ${JSON.stringify(text)}`,
        );
      });
    }

    // --- no marimo multi-def diagnostic yet -----------------------------
    for (const cell of nb.getCells()) {
      const diags = vscode.languages.getDiagnostics(cell.document.uri);
      NodeAssert.deepStrictEqual(
        marimoMultiDef(diags),
        [],
        `expected no marimo multi-def on ${cell.document.uri.toString()}, got ${JSON.stringify(diags)}`,
      );
    }

    // --- append a redefining cell (must use mo-python language id) ------
    const edit = new vscode.WorkspaceEdit();
    const newCell = new vscode.NotebookCellData(
      vscode.NotebookCellKind.Code,
      "a = 20",
      "mo-python",
    );
    edit.set(nb.uri, [
      vscode.NotebookEdit.insertCells(nb.cellCount, [newCell]),
    ]);
    NodeAssert.ok(
      await vscode.workspace.applyEdit(edit),
      "workspace.applyEdit should succeed",
    );

    // --- marimo multi-def diagnostic lands on both definition cells ----
    await ctx.waitUntil(() => {
      NodeAssert.strictEqual(nb.cellCount, 4);
      const defA = nb.cellAt(1); // `a = 10`
      const defB = nb.cellAt(3); // `a = 20`
      const dA = vscode.languages.getDiagnostics(defA.document.uri);
      const dB = vscode.languages.getDiagnostics(defB.document.uri);
      NodeAssert.ok(
        marimoMultiDef(dA).length > 0,
        `cell 1 (a = 10) should have multi-def, got ${JSON.stringify(dA)}`,
      );
      NodeAssert.ok(
        marimoMultiDef(dB).length > 0,
        `cell 3 (a = 20) should have multi-def, got ${JSON.stringify(dB)}`,
      );
    });
  });
});
