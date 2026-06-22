// @ts-check
/// <reference types="mocha" />

// Integration coverage for the cell-output emission/reconcile path
// (`ExecutionRegistry`): re-running a cell must reconcile its outputs in place
// rather than stacking or duplicating them, and the built-in error/stdout
// outputs must survive every re-run.
//
// The *visual* defect this guards against (a traceback collapsing/overlapping
// on repeated runs) is a webview height problem the test harness can't see as
// pixels — that's verified separately via the dev host. What we can assert
// structurally is that the emission model stays well-formed across re-runs:
// stable output count, correct order, and a failed-execution summary.

const NodeAssert = require("node:assert");
const vscode = require("vscode");

const { createTestContext, selectKernel, runCell } = require("./helpers.cjs");

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

const STDOUT_MIME = "application/vnd.code.notebook.stdout";
const ERROR_MIME = "application/vnd.code.notebook.error";

/**
 * Build marimo notebook source from an array of cell body strings.
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
 * Flatten a cell's outputs into `{ mime }` descriptors, in order.
 *
 * @param {vscode.NotebookCell} cell
 */
function outputItemMimes(cell) {
  return cell.outputs.flatMap((output) =>
    output.items.map((item) => item.mime),
  );
}

/**
 * @param {vscode.NotebookCell} cell
 */
function cellOutputText(cell) {
  const decoder = new TextDecoder();
  return cell.outputs
    .flatMap((output) => output.items.map((item) => decoder.decode(item.data)))
    .join("");
}

// The canonical acceptance repro from the goal: stdout followed by an
// uncaught exception. Running it any number of times must leave exactly the
// same well-formed output set.
const ERROR_REPRO = "print(10)\nraise ValueError()";

suite("output reconcile on re-run", function () {
  test("repeated runs keep stdout + traceback without stacking", async function () {
    this.timeout(60_000);
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(makeSource([ERROR_REPRO]));
    await selectKernel(nb);

    /** @type {number | undefined} */
    let baselineCount;

    for (let run = 1; run <= 3; run++) {
      const cell = nb.cellAt(0);
      // oxlint-disable-next-line eslint/no-await-in-loop
      await runCell(cell);

      // The execution failed (red error icon), matching Jupyter.
      NodeAssert.strictEqual(
        cell.executionSummary?.success,
        false,
        `run ${run}: expected a failed execution, got ${JSON.stringify(
          cell.executionSummary,
        )}`,
      );

      const mimes = outputItemMimes(cell);

      // Both built-in outputs survive every run...
      NodeAssert.ok(
        mimes.includes(STDOUT_MIME),
        `run ${run}: expected a stdout output, got ${JSON.stringify(mimes)}`,
      );
      NodeAssert.ok(
        mimes.includes(ERROR_MIME),
        `run ${run}: expected a built-in error (traceback) output, got ${JSON.stringify(
          mimes,
        )}`,
      );

      // ...and the printed value is still visible.
      NodeAssert.match(cellOutputText(cell), /10/);

      // ...in arrival order: stdout precedes the traceback (Jupyter-like),
      // not result-first.
      NodeAssert.ok(
        mimes.indexOf(STDOUT_MIME) < mimes.indexOf(ERROR_MIME),
        `run ${run}: stdout should precede the traceback, got ${JSON.stringify(
          mimes,
        )}`,
      );

      // Re-running reconciles in place — the output count never grows.
      if (baselineCount === undefined) {
        baselineCount = cell.outputs.length;
        NodeAssert.ok(
          baselineCount >= 2,
          `expected at least stdout + traceback outputs, got ${baselineCount}`,
        );
      } else {
        NodeAssert.strictEqual(
          cell.outputs.length,
          baselineCount,
          `run ${run}: output count changed across re-runs (stacking?)`,
        );
      }
    }
  });

  test("rapid re-runs settle to a single well-formed output set", async function () {
    this.timeout(60_000);
    await using ctx = createTestContext();
    const nb = await ctx.writeAndOpenNotebook(makeSource([ERROR_REPRO]));
    await selectKernel(nb);

    // Establish the steady-state output count with one clean run.
    await runCell(nb.cellAt(0));
    const baselineCount = nb.cellAt(0).outputs.length;

    // Spam executions; only await the final one's finalization.
    for (let i = 0; i < 3; i++) {
      void vscode.commands.executeCommand("notebook.cell.execute", {
        ranges: [{ start: 0, end: 1 }],
        document: nb.uri,
      });
    }
    await runCell(nb.cellAt(0));

    // Outputs settle back to the same shape — no leftover/duplicated outputs
    // from the interrupted-then-restarted runs.
    await ctx.waitUntil(() => {
      const cell = nb.cellAt(0);
      NodeAssert.strictEqual(
        cell.executionSummary?.success,
        false,
        `expected a failed execution, got ${JSON.stringify(
          cell.executionSummary,
        )}`,
      );
      const mimes = outputItemMimes(cell);
      NodeAssert.ok(
        mimes.includes(STDOUT_MIME) && mimes.includes(ERROR_MIME),
        `expected stdout + traceback after rapid re-runs, got ${JSON.stringify(
          mimes,
        )}`,
      );
      NodeAssert.strictEqual(
        cell.outputs.length,
        baselineCount,
        `output count drifted after rapid re-runs, got ${cell.outputs.length} vs ${baselineCount}`,
      );
    });
  });
});
