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
    // Bumped above the 30s mocha default because this is the first test to
    // bind a kernel on a fresh runner, and the cold-start cost on Linux CI
    // (post-venv bootstrap kernel spin-up) sometimes exceeds 30s even
    // though subsequent tests reuse the warm kernel in seconds.
    this.timeout(60_000);
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
