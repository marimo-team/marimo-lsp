// @ts-check
/// <reference types="mocha" />

// End-to-end coverage for the code-mode replay path: an agent runs code in the
// kernel via the `execute-code` API, commits a cell through `marimo._code_mode`,
// and the resulting document transaction is replayed onto the live VS Code
// notebook. Exercises Phase 1 (scratchpad binds code mode) + Phase 2 (the
// transaction applier) together, as a user would experience it.
//
// The transaction → NotebookEdit translation is unit-tested in
// `src/notebook/__tests__/transactionPlan.test.ts`; this proves the full path.

const NodeAssert = require("node:assert");
const vscode = require("vscode");

const {
  cellOutputText,
  createTestContext,
  runCell,
  selectKernel,
} = require("./helpers.cjs");

const EXTENSION_ID = "marimo-team.vscode-marimo";

const SOURCE = `# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
# ]
# ///

import marimo

app = marimo.App()


@app.cell
def _():
    print(11)
    return


if __name__ == "__main__":
    app.run()
`;

// Run inside the scratchpad: commit one cell through code mode. Top-level await
// is supported by the kernel; the ops flush as a transaction on block exit.
const CREATE_VIA_CODE_MODE = [
  "import marimo._code_mode as cm",
  "async with cm.get_context() as ctx:",
  "    ctx.create_cell('z = 1')",
  "",
].join("\n");

/** @returns {{ experimental: { kernels: { getKernel: (uri: import('vscode').Uri) => Promise<{ executeCode: (code: string) => AsyncIterable<unknown> } | undefined> } } }} */
function getMarimoApi() {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  NodeAssert.ok(ext, `Extension ${EXTENSION_ID} should be installed`);
  return ext.exports;
}

suite("code mode replays into the notebook", function () {
  this.timeout(30_000);

  test("a cell committed via code mode appears, preserving prior output", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(SOURCE);
    await selectKernel(nb);

    // Run the existing cell — creates + instantiates the session and gives the
    // cell an output we can later assert survived the replay.
    await runCell(nb.cellAt(0));
    NodeAssert.match(cellOutputText(nb.cellAt(0)), /11/);

    // Drive code mode through the public execute-code API and drain the
    // scratchpad stream so the batch runs to completion.
    const kernel = await getMarimoApi().experimental.kernels.getKernel(nb.uri);
    NodeAssert.ok(kernel, "expected a live kernel for the notebook");
    for await (const _part of kernel.executeCode(CREATE_VIA_CODE_MODE)) {
      // no-op: we only need the run to finish
    }

    // The CreateCell transaction is replayed onto the notebook.
    await ctx.waitUntil(() => {
      NodeAssert.strictEqual(nb.cellCount, 2);
      NodeAssert.match(nb.cellAt(1).document.getText(), /z = 1/);
    });

    // The pre-existing cell sat in the stable prefix, so its output is intact.
    NodeAssert.match(
      cellOutputText(nb.cellAt(0)),
      /11/,
      "prior cell output preserved across the replay",
    );
  });
});
