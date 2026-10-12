// @ts-check
/// <reference types="mocha" />

// Integration coverage for the managed ty server's lifetime: it must not run
// while no marimo notebook is open, start with the first notebook, and stop
// once the last one has stayed closed. The unit tests cover the Effect
// wiring over a fake; this suite checks the real VS Code notebook events and
// the real server process.
//
// It runs in its own VS Code instance (see `.vscode-test.cjs`): the
// assertions depend on no marimo notebook being open anywhere in the window,
// and notebooks the other suites open through the API stay pinned by the
// extension host for minutes after their editors close.

const NodeAssert = require("node:assert");
const NodeChildProcess = require("node:child_process");
const vscode = require("vscode");

const { createTestContext } = require("../helpers.cjs");

const WAITING = "waiting for a marimo notebook";
const RUNNING = "running ✓";

/** PIDs of `ty server` processes spawned by this extension host. */
function tyServerPids() {
  const output = NodeChildProcess.execFileSync(
    "ps",
    ["-axo", "pid=,ppid=,command="],
    { encoding: "utf8" },
  );
  /** @type {number[]} */
  const pids = [];
  for (const line of output.split("\n")) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!match) continue;
    const [, pid, ppid, command] = match;
    if (Number(ppid) === process.pid && /(^|\/)ty server$/.test(command)) {
      pids.push(Number(pid));
    }
  }
  return pids;
}

/**
 * The ty status line of the health report. The report opens as an untitled
 * document, which is reverted and closed again so it cannot pile up or
 * prompt to save.
 */
async function tyHealthStatus() {
  // oxlint-disable-next-line marimo/no-marimo-command-id-literals -- external VS Code seam
  await vscode.commands.executeCommand("marimo.showDiagnostics");
  const editor = vscode.window.activeTextEditor;
  NodeAssert.ok(editor, "health report should open in an editor");
  NodeAssert.ok(
    editor.document.isUntitled,
    "health report should be the active editor",
  );
  const text = editor.document.getText();
  await vscode.commands.executeCommand(
    "workbench.action.revertAndCloseActiveEditor",
  );
  const match = text.match(
    /Python Language Server \(ty\):\n\tStatus: ([^\n]*)/,
  );
  NodeAssert.ok(match, `health report has no ty section: ${text}`);
  return match[1];
}

/**
 * @param {readonly number[]} pids
 * @param {readonly number[]} except
 */
function without(pids, except) {
  return pids.filter((pid) => !except.includes(pid));
}

/**
 * Opens a fresh notebook in an editor, the way a user does. A document
 * opened through `openNotebookDocument` is pinned by the extension host for
 * a while after its editor closes, so it could not exercise the close path.
 *
 * @param {ReturnType<typeof createTestContext>} ctx
 */
async function openNotebookEditor(ctx) {
  const uri = await ctx.writeTempFile();
  await vscode.commands.executeCommand(
    "vscode.openWith",
    uri,
    "marimo-notebook",
  );
  /** @type {vscode.NotebookDocument | undefined} */
  let notebook;
  await ctx.waitUntil(() => {
    notebook = vscode.workspace.notebookDocuments.find(
      (candidate) => candidate.uri.toString() === uri.toString(),
    );
    NodeAssert.ok(notebook, "notebook should be open");
  });
  NodeAssert.ok(notebook);
  NodeAssert.strictEqual(notebook.notebookType, "marimo-notebook");
  return notebook;
}

suite("managed ty lifetime", function () {
  this.timeout(90_000);

  // The official ty extension is installed in the test host and runs its own
  // `ty server` from the same extension host, so the assertions below track
  // which processes appear and disappear rather than absolute counts.
  test("ty runs only while a marimo notebook is open", async function () {
    const extension = vscode.extensions.getExtension(
      "marimo-team.vscode-marimo",
    );
    NodeAssert.ok(extension, "extension should be installed");
    await extension.activate();
    await using ctx = createTestContext();

    // Activation alone must not start ty: nothing is open yet.
    await ctx.waitUntil(() => {
      NodeAssert.deepStrictEqual(
        vscode.workspace.notebookDocuments
          .filter((nb) => nb.notebookType === "marimo-notebook")
          .map((nb) => nb.uri.toString()),
        [],
      );
    });
    const beforeOpen = tyServerPids();
    NodeAssert.strictEqual(await tyHealthStatus(), WAITING);

    // The first notebook starts the server.
    const first = await openNotebookEditor(ctx);
    await ctx.waitUntil(() =>
      NodeAssert.ok(without(tyServerPids(), beforeOpen).length >= 1),
    );
    await ctx.waitUntil(
      async () => NodeAssert.strictEqual(await tyHealthStatus(), RUNNING),
      500,
    );
    const afterOpen = tyServerPids();

    // Closing the last notebook stops it after the grace period: exactly
    // one of the servers that were running goes away.
    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await ctx.waitUntil(() => NodeAssert.ok(first.isClosed, "notebook closed"));
    await ctx.waitUntil(() => {
      NodeAssert.strictEqual(without(afterOpen, tyServerPids()).length, 1);
    }, 250);
    const afterClose = tyServerPids();
    NodeAssert.strictEqual(await tyHealthStatus(), WAITING);

    // The next notebook starts a fresh server.
    const second = await openNotebookEditor(ctx);
    await ctx.waitUntil(() =>
      NodeAssert.strictEqual(without(tyServerPids(), afterClose).length, 1),
    );
    await ctx.waitUntil(
      async () => NodeAssert.strictEqual(await tyHealthStatus(), RUNNING),
      500,
    );

    await vscode.commands.executeCommand("workbench.action.closeAllEditors");
    await ctx.waitUntil(() =>
      NodeAssert.ok(second.isClosed, "notebook closed"),
    );
  });
});
