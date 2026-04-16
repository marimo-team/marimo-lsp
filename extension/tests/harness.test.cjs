// @ts-check
/// <reference types="mocha" />

const assert = require("node:assert");

const {
  writeTempNotebook,
  openMarimoNotebook,
  selectSandboxController,
  editCellText,
  runCell,
  getCellOutputText,
} = require("./helpers.cjs");

suite("harness: write → open → run → edit → run", () => {
  test("round-trips a single cell through the sandbox controller", async function () {
    // First run downloads uv cache + resolves marimo; be generous.
    this.timeout(180_000);

    const { uri, cleanup } = await writeTempNotebook();
    try {
      const notebook = await openMarimoNotebook(uri);
      assert.strictEqual(notebook.cellCount, 1, "should have 1 cell");
      assert.match(
        notebook.cellAt(0).document.getText(),
        /print\(10\)/,
        "initial cell should contain print(10)",
      );

      await selectSandboxController(notebook);
      await runCell(notebook, 0);

      const firstOutput = getCellOutputText(notebook.cellAt(0));
      assert.match(
        firstOutput,
        /10/,
        `expected "10" in cell output, got: ${JSON.stringify(firstOutput)}`,
      );

      await editCellText(notebook, 0, "print(20)\n");
      assert.match(
        notebook.cellAt(0).document.getText(),
        /print\(20\)/,
        "cell text should be updated to print(20)",
      );

      await runCell(notebook, 0);
      const secondOutput = getCellOutputText(notebook.cellAt(0));
      assert.match(
        secondOutput,
        /20/,
        `expected "20" in cell output after edit, got: ${JSON.stringify(secondOutput)}`,
      );
    } finally {
      await cleanup();
    }
  });
});
