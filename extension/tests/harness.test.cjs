// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert");

const {
  cellOutputText,
  createTestContext,
  editCell,
  runCell,
  selectKernel,
} = require("./helpers.cjs");

suite("harness: write → open → run → edit → run", () => {
  test("round-trips a single cell through the shared-venv python controller", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook();

    NodeAssert.strictEqual(nb.cellCount, 1, "should have 1 cell");
    NodeAssert.match(
      nb.cellAt(0).document.getText(),
      /print\(10\)/,
      "initial cell should contain print(10)",
    );

    await selectKernel(nb);

    await runCell(nb.cellAt(0));
    NodeAssert.match(cellOutputText(nb.cellAt(0)), /10/);

    await editCell(nb.cellAt(0), "print(20)\n");
    NodeAssert.match(
      nb.cellAt(0).document.getText(),
      /print\(20\)/,
      "cell text should reflect the edit",
    );

    await runCell(nb.cellAt(0));
    NodeAssert.match(cellOutputText(nb.cellAt(0)), /20/);
  });
});
