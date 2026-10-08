// @ts-check
/// <reference types="mocha" />

// Integration coverage for issue #497 — outputs must survive external file
// edits. Each case writes a different edit pattern to disk and asserts that
// cells we *didn't* edit retain their outputs after VS Code re-deserializes.
//
// Unit tests in `tests/notebook/reconcileNotebook.test.ts` exercise
// the cell-level matcher exhaustively; the tests here are end-to-end —
// they verify the full path from `fs.writeFile` through the serializer's
// `pickLiveNotebook` match and into the live `NotebookDocument`'s outputs.

const NodeAssert = require("node:assert");
const NodeFs = require("node:fs/promises");
const vscode = require("vscode");
const tinyspy = require("tinyspy");

const {
  cellOutputText,
  createTestContext,
  editCell,
  runCell,
  selectKernel,
} = require("./helpers.cjs");

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
 * @param {import('vscode').NotebookDocument} nb
 */
async function runAllCells(nb) {
  for (let i = 0; i < nb.cellCount; i++) {
    // oxlint-disable-next-line eslint/no-await-in-loop
    await runCell(nb.cellAt(i));
  }
}

suite("external edit output preservation (issue #497)", function () {
  // Short timeout for fast local feedback — when a `waitUntil` hangs
  // because the external edit wasn't picked up, we want the failure to
  // surface in seconds, not minutes.
  this.timeout(15_000);

  test("append: new cell at end leaves prior outputs intact", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(
      makeSource(["print(11)", "print(22)"]),
    );
    await selectKernel(nb);
    await runAllCells(nb);

    NodeAssert.match(cellOutputText(nb.cellAt(0)), /11/);
    NodeAssert.match(cellOutputText(nb.cellAt(1)), /22/);

    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(11)", "print(22)", "print(33)"]),
      "utf8",
    );
    await ctx.waitUntil(() => NodeAssert.strictEqual(nb.cellCount, 3));

    NodeAssert.match(cellOutputText(nb.cellAt(0)), /11/, "cell 0 preserved");
    NodeAssert.match(cellOutputText(nb.cellAt(1)), /22/, "cell 1 preserved");
    NodeAssert.strictEqual(
      cellOutputText(nb.cellAt(2)),
      "",
      "new cell 2 has no output",
    );
  });

  test("prepend: new cell at start preserves suffix outputs", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(
      makeSource(["print(11)", "print(22)"]),
    );
    await selectKernel(nb);
    await runAllCells(nb);

    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(99)", "print(11)", "print(22)"]),
      "utf8",
    );
    await ctx.waitUntil(() => NodeAssert.strictEqual(nb.cellCount, 3));

    NodeAssert.strictEqual(
      cellOutputText(nb.cellAt(0)),
      "",
      "new leading cell has no output",
    );
    NodeAssert.match(
      cellOutputText(nb.cellAt(1)),
      /11/,
      "cell 1 preserved via suffix match",
    );
    NodeAssert.match(
      cellOutputText(nb.cellAt(2)),
      /22/,
      "cell 2 preserved via suffix match",
    );
  });

  for (const running of [false, true]) {
    test(`insert-in-middle: cells execute after reload with ${running ? "a running kernel" : "no kernel started"}`, async function () {
      await using ctx = createTestContext();
      const nb = await ctx.writeAndOpenNotebook(
        makeSource(["print(11)", "print(22)"]),
      );
      // Selecting the controller prepares the editor but does not start a
      // kernel; the first execution below creates the cold notebook's session.
      await selectKernel(nb);
      if (running) {
        await runAllCells(nb);
      }
      const originalIds = nb
        .getCells()
        .map((cell) => cell.metadata.marimoRuntime.stableId);

      await NodeFs.writeFile(
        nb.uri.fsPath,
        makeSource(["print(11)", "print(99)", "print(22)"]),
        "utf8",
      );
      await ctx.waitUntil(() => NodeAssert.strictEqual(nb.cellCount, 3));

      const reloadedIds = nb
        .getCells()
        .map((cell) => cell.metadata.marimoRuntime.stableId);
      NodeAssert.deepStrictEqual([reloadedIds[0], reloadedIds[2]], originalIds);
      NodeAssert.strictEqual(new Set(reloadedIds).size, 3);
      if (running) {
        NodeAssert.match(
          cellOutputText(nb.cellAt(0)),
          /11/,
          "prefix preserved",
        );
        NodeAssert.match(
          cellOutputText(nb.cellAt(2)),
          /22/,
          "suffix preserved",
        );
      }
      NodeAssert.strictEqual(
        cellOutputText(nb.cellAt(1)),
        "",
        "inserted cell has no output",
      );
      // Start with the inserted cell: on a cold notebook this creates the session
      // from the reloaded IDs, exercising the failure reported in #850.
      for (const [index, expected] of [
        [1, 99],
        [0, 11],
        [2, 22],
      ]) {
        // oxlint-disable-next-line eslint/no-await-in-loop
        await runCell(nb.cellAt(index));
        NodeAssert.strictEqual(
          nb.cellAt(index).executionSummary?.success,
          true,
        );
        NodeAssert.match(
          cellOutputText(nb.cellAt(index)),
          new RegExp(String(expected)),
        );
      }
    });
  }

  test("delete: remaining cells keep their outputs", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(
      makeSource(["print(11)", "print(22)", "print(33)"]),
    );
    await selectKernel(nb);
    await runAllCells(nb);

    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(11)", "print(33)"]),
      "utf8",
    );
    await ctx.waitUntil(() => NodeAssert.strictEqual(nb.cellCount, 2));

    NodeAssert.match(cellOutputText(nb.cellAt(0)), /11/);
    NodeAssert.match(
      cellOutputText(nb.cellAt(1)),
      /33/,
      "cell that was at index 2 now at index 1 via suffix match",
    );
  });

  test("edit-in-place: preserved output is stale until rerun", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(
      makeSource(["print(11)", "print(22)", "print(33)"]),
    );
    await selectKernel(nb);
    await runAllCells(nb);

    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(11)", "print(99)", "print(33)"]),
      "utf8",
    );
    await ctx.waitUntil(() =>
      NodeAssert.match(nb.cellAt(1).document.getText(), /print\(99\)/),
    );

    NodeAssert.match(cellOutputText(nb.cellAt(0)), /11/);
    NodeAssert.match(
      cellOutputText(nb.cellAt(1)),
      /22/,
      "edited cell inherits prior output via positional fallback",
    );
    NodeAssert.match(cellOutputText(nb.cellAt(2)), /33/);

    // Exercise the same action as the cell's Stale indicator. Only cells the
    // extension considers stale are executed by this command.
    // oxlint-disable-next-line marimo/no-marimo-command-id-literals -- exercises the external VS Code seam
    await vscode.commands.executeCommand("marimo.runStale", nb.cellAt(1));
    await ctx.waitUntil(() => {
      NodeAssert.match(cellOutputText(nb.cellAt(1)), /99/);
      NodeAssert.strictEqual(nb.cellAt(1).executionSummary?.success, true);
    });

    const information = tinyspy.spyOn(
      vscode.window,
      "showInformationMessage",
      async () => undefined,
    );
    try {
      // oxlint-disable-next-line marimo/no-marimo-command-id-literals -- exercises the external VS Code seam
      await vscode.commands.executeCommand("marimo.runStale", nb.cellAt(1));
      NodeAssert.strictEqual(
        information.calls[0]?.[0],
        "No stale cells to run",
      );
    } finally {
      information.restore();
    }
  });

  test("whitespace-only change: output preserved via normalized match", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(
      makeSource(["print(11)", "print(22)"]),
    );
    await selectKernel(nb);
    await runAllCells(nb);

    // Add a trailing blank line inside cell 1's body — same trimmed content,
    // different raw text. Normalized matching should still pair the cells.
    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(11)", "print(22)\n"]),
      "utf8",
    );
    await ctx.waitUntil(() =>
      NodeAssert.match(nb.cellAt(1).document.getText(), /print\(22\)/),
    );

    NodeAssert.match(cellOutputText(nb.cellAt(0)), /11/);
    NodeAssert.match(
      cellOutputText(nb.cellAt(1)),
      /22/,
      "cell with whitespace-only change keeps its output",
    );
  });

  test("chained external edits: outputs survive multiple successive rewrites", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(
      makeSource(["print(11)", "print(22)"]),
    );
    await selectKernel(nb);
    await runAllCells(nb);

    // Edit #1: append a third cell.
    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(11)", "print(22)", "print(33)"]),
      "utf8",
    );
    await ctx.waitUntil(() => NodeAssert.strictEqual(nb.cellCount, 3));
    NodeAssert.match(cellOutputText(nb.cellAt(0)), /11/);
    NodeAssert.match(cellOutputText(nb.cellAt(1)), /22/);

    // Edit #2: append a fourth cell on top of the already-reloaded doc.
    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(11)", "print(22)", "print(33)", "print(44)"]),
      "utf8",
    );
    await ctx.waitUntil(() => NodeAssert.strictEqual(nb.cellCount, 4));

    NodeAssert.match(
      cellOutputText(nb.cellAt(0)),
      /11/,
      "original output still intact after two external edits",
    );
    NodeAssert.match(cellOutputText(nb.cellAt(1)), /22/);
    NodeAssert.strictEqual(
      cellOutputText(nb.cellAt(2)),
      "",
      "cell added by first external edit was never run",
    );
    NodeAssert.strictEqual(cellOutputText(nb.cellAt(3)), "");
  });

  test("dirty notebook: external write does not clobber unsaved edits", async function () {
    // VS Code's dirty-conflict protection: when a notebook has unsaved
    // in-memory edits and the file changes on disk, VS Code does NOT
    // auto-revert — the user must explicitly reload. Our deserializer is
    // never invoked for the external bytes, so our matcher doesn't need
    // to reason about stale in-memory state. This test pins that invariant
    // so we notice if the VS Code behavior ever shifts.
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(
      makeSource(["print(11)", "print(22)"]),
    );
    await selectKernel(nb);
    await runAllCells(nb);

    // Make the notebook dirty with an in-memory edit that differs from disk.
    await editCell(nb.cellAt(0), "print(111)\n");
    NodeAssert.strictEqual(nb.isDirty, true, "editCell should dirty the doc");

    // External write: different cell count + different cell 0 content.
    await NodeFs.writeFile(
      nb.uri.fsPath,
      makeSource(["print(222)", "print(22)", "print(33)"]),
      "utf8",
    );

    // Give VS Code time to NOT pick up the change. There's no positive
    // signal to wait on (that's the whole point), so we settle briefly
    // and then assert absence.
    await new Promise((resolve) => setTimeout(resolve, 500));

    NodeAssert.strictEqual(
      nb.cellCount,
      2,
      "dirty notebook should retain its in-memory cell count",
    );
    NodeAssert.match(
      nb.cellAt(0).document.getText(),
      /print\(111\)/,
      "user's in-memory edit should win over external write",
    );
    NodeAssert.match(
      cellOutputText(nb.cellAt(1)),
      /22/,
      "outputs on unedited cells should still be intact",
    );
    NodeAssert.strictEqual(nb.isDirty, true, "doc should still be dirty");
  });

  test("save before external edit: output still preserved on single-cell edit-in-place", async function () {
    // Reported scenario: user edits a cell to print(10), runs it, saves the
    // notebook, then an external tool rewrites the cell to print(20). They
    // expect the positional-fallback behavior (print(20) text with the stale
    // "10" output) but see no output at all. The only variable vs. the other
    // edit-in-place test is that a save happens between run and external write.
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(makeSource(["pass"]));
    await selectKernel(nb);

    // Dirty the doc with an in-memory edit to print(10).
    await editCell(nb.cellAt(0), "print(10)\n");
    await runCell(nb.cellAt(0));
    NodeAssert.match(cellOutputText(nb.cellAt(0)), /10/);

    // Save — writes print(10) to disk, clears dirty.
    const saved = await nb.save();
    NodeAssert.strictEqual(saved, true, "save should succeed");
    NodeAssert.strictEqual(nb.isDirty, false, "save should clear dirty");

    // External rewrite to print(20).
    await NodeFs.writeFile(nb.uri.fsPath, makeSource(["print(20)"]), "utf8");
    await ctx.waitUntil(() =>
      NodeAssert.match(nb.cellAt(0).document.getText(), /print\(20\)/),
    );

    NodeAssert.match(
      cellOutputText(nb.cellAt(0)),
      /10/,
      "output should survive save + external edit via positional fallback",
    );

    // Second external rewrite on top of the already-reloaded doc.
    await NodeFs.writeFile(nb.uri.fsPath, makeSource(["print(30)"]), "utf8");
    await ctx.waitUntil(() =>
      NodeAssert.match(nb.cellAt(0).document.getText(), /print\(30\)/),
    );

    NodeAssert.match(
      cellOutputText(nb.cellAt(0)),
      /10/,
      "output should survive a second external edit via positional fallback",
    );
  });

  test("internal edit (no external write): output survives in-memory cell change", async function () {
    // Exactly the user-reported flow: edit cell to print(10), run, then edit
    // in VS Code (workspace applyEdit) to print(20). NO external write, NO
    // save. Positional fallback lives in the external-edit path, so this
    // test isolates whether the internal-edit path (kernel cell-ops, LSP
    // notifications, stale detection) is the one clearing outputs.
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(makeSource(["pass"]));
    await selectKernel(nb);

    await editCell(nb.cellAt(0), "print(10)\n");
    await runCell(nb.cellAt(0));
    NodeAssert.match(cellOutputText(nb.cellAt(0)), /10/);

    // Internal edit — user types new content in VS Code. Don't run, don't save.
    await editCell(nb.cellAt(0), "print(20)\n");

    // Give any async LSP/kernel reactions a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 500));

    NodeAssert.match(nb.cellAt(0).document.getText(), /print\(20\)/);
    NodeAssert.match(
      cellOutputText(nb.cellAt(0)),
      /10/,
      "output should persist across an internal cell edit (nothing reran it)",
    );
  });
});

// Issue #323: when an external tool (e.g. Ruff) reformats a cell, dependent
// cells used to re-run before the definition cell had re-run, producing a
// NameError. Before our fix, stableIds churned on every deserialize so the
// kernel's dependency graph lost track of cells — dependents got scheduled
// against the wrong upstream identity.
const ISSUE_323_INITIAL = `# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
# ]
# ///

import marimo

app = marimo.App()


@app.cell
def _():
    x = 5
    return (x,)


@app.cell
def _(x):
    print(x)
    return


if __name__ == "__main__":
    app.run()
`;

// Semantically equivalent — just a formatter-style trailing comment on the
// definition cell. Content hash changes, behavior does not.
const ISSUE_323_REFORMATTED = `# /// script
# requires-python = ">=3.11"
# dependencies = [
#     "marimo",
# ]
# ///

import marimo

app = marimo.App()


@app.cell
def _():
    x = 5  # reformatted by tooling
    return (x,)


@app.cell
def _(x):
    print(x)
    return


if __name__ == "__main__":
    app.run()
`;

suite("external edit cell dependencies (issue #323)", function () {
  this.timeout(20_000);

  test("reformatting a definition cell externally does not break dependents with NameError", async function () {
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(ISSUE_323_INITIAL);
    await selectKernel(nb);
    await runAllCells(nb);

    NodeAssert.match(
      cellOutputText(nb.cellAt(1)),
      /5/,
      "baseline: dependent cell prints 5",
    );

    // External reformat — changes cell 0's bytes but not its semantics.
    await NodeFs.writeFile(nb.uri.fsPath, ISSUE_323_REFORMATTED, "utf8");
    await ctx.waitUntil(() =>
      NodeAssert.match(
        nb.cellAt(0).document.getText(),
        /reformatted by tooling/,
      ),
    );

    // Let marimo's autorun settle if it fires on the reload.
    await new Promise((resolve) => setTimeout(resolve, 1500));

    const depOutput = cellOutputText(nb.cellAt(1));
    NodeAssert.doesNotMatch(
      depOutput,
      /NameError/,
      `dependent cell must not raise NameError. Got: ${depOutput}`,
    );
    NodeAssert.match(
      depOutput,
      /5/,
      `dependent cell should still show "5". Got: ${depOutput}`,
    );
  });
});
