// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert");
const vscode = require("vscode");
const tinyspy = require("tinyspy");

const { createTestContext } = require("./helpers.cjs");

suite("notebook command context", () => {
  test("accepts the NotebookCell supplied by a cell status-bar command", async function () {
    this.timeout(60_000);
    await using ctx = createTestContext();
    const notebook = await ctx.writeAndOpenNotebook();
    await vscode.window.showNotebookDocument(notebook);

    const originalCell = notebook.cellAt(0);

    const warning = tinyspy.spyOn(
      vscode.window,
      "showWarningMessage",
      async () => undefined,
    );
    const information = tinyspy.spyOn(
      vscode.window,
      "showInformationMessage",
      async () => undefined,
    );
    try {
      // The clickable "Stale" NotebookCellStatusBarItem uses a bare command
      // string. VS Code prepends the item's NotebookCell when invoking it.
      // oxlint-disable-next-line marimo/no-marimo-command-id-literals -- exercises the external VS Code seam
      await vscode.commands.executeCommand("marimo.runStale", originalCell);

      NodeAssert.strictEqual(warning.callCount, 0);
      NodeAssert.strictEqual(information.callCount, 1);
      NodeAssert.strictEqual(
        information.calls[0]?.[0],
        "No stale cells to run",
      );
    } finally {
      warning.restore();
      information.restore();
    }
  });
});
