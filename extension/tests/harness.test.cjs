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
  test("round-trips a single cell through the sandbox controller", async function () {
    // First run downloads uv cache + resolves marimo; be generous.
    this.timeout(180_000);
    await using ctx = createTestContext({ timeoutMs: 170_000 });
    const nb = await ctx.writeAndOpenNotebook();

    NodeAssert.strictEqual(nb.cellCount, 1, "should have 1 cell");
    NodeAssert.match(
      nb.cellAt(0).document.getText(),
      /print\(10\)/,
      "initial cell should contain print(10)",
    );

    await selectKernel(nb);

    await runCell(nb.cellAt(0));
    await ctx.waitUntil(() => {
      NodeAssert.match(cellOutputText(nb.cellAt(0)), /10/);
    });

    await editCell(nb.cellAt(0), "print(20)\n");
    NodeAssert.match(
      nb.cellAt(0).document.getText(),
      /print\(20\)/,
      "cell text should be updated to print(20)",
    );

    await runCell(nb.cellAt(0));
    await ctx.waitUntil(() => {
      NodeAssert.match(cellOutputText(nb.cellAt(0)), /20/);
    });
  });
});
