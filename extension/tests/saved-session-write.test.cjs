// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert");
const NodeChildProcess = require("node:child_process");
const NodeFs = require("node:fs/promises");
const NodeUtil = require("node:util");
const tinyspy = require("tinyspy");
const vscode = require("vscode");

const {
  createTestContext,
  ensureSharedVenv,
  selectKernel,
  cellOutputText,
} = require("./helpers.cjs");

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

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
    import time
    print(f"live output {time.time_ns()}")
    return


@app.cell
def _():
    40 + 2
    return


if __name__ == "__main__":
    app.run()
`;

const LOCATE_MARIMO_SAVED_SESSION = String.raw`
import pathlib
import sys

from marimo._session.state.serialize import get_session_cache_file

print(get_session_cache_file(pathlib.Path(sys.argv[1])).absolute())
`;

const READ_MARIMO_SAVED_SESSION = String.raw`
import json
import pathlib
import sys

import marimo
from marimo._messaging.notebook.document import NotebookDocument
from marimo._session.notebook.file_manager import AppFileManager
from marimo._session.state.serialize import (
    _script_metadata_hash,
    SessionCacheKey,
    SessionCacheManager,
)
from marimo._session.state.session_view import SessionView
from marimo._utils.lists import as_list

notebook_path = pathlib.Path(sys.argv[1])
app = AppFileManager(notebook_path).app
cell_ids = tuple(app.cell_manager.cell_ids())
codes = tuple(app.cell_manager.codes())
manager = SessionCacheManager(
    session_view=SessionView(),
    document=NotebookDocument([]),
    path=notebook_path,
    interval=1,
)
view = manager.read_session_view(
    SessionCacheKey(
        codes=codes,
        marimo_version=marimo.__version__,
        cell_ids=cell_ids,
        script_metadata_hash=_script_metadata_hash(notebook_path),
    )
)
payload = []
for cell_id in cell_ids:
    notification = view.cell_notifications.get(cell_id)
    payload.append(
        {
            "output": (
                None
                if notification is None or notification.output is None
                else str(notification.output.data)
            ),
            "console": (
                []
                if notification is None
                else [str(item.data) for item in as_list(notification.console)]
            ),
        }
    )
print(json.dumps(payload))
`;

const WRITE_MARIMO_SAVED_SESSION = String.raw`
import json
import pathlib
import sys

from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._runtime.commands import ExecuteCellsCommand
from marimo._session.notebook.file_manager import AppFileManager
from marimo._session.state.serialize import (
    _script_metadata_hash,
    get_session_cache_file,
    serialize_session_view,
)
from marimo._session.state.session_view import SessionView

notebook_path = pathlib.Path(sys.argv[1])
app = AppFileManager(notebook_path).app
cell_ids = tuple(app.cell_manager.cell_ids())
codes = tuple(app.cell_manager.codes())
view = SessionView()
view.add_control_request(ExecuteCellsCommand(cell_ids=cell_ids, codes=codes))
for cell_id, output in zip(cell_ids, ("cli first", "cli second"), strict=True):
    view.add_notification(
        CellNotification(
            cell_id=cell_id,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data=output,
            ),
            console=[],
            timestamp=1,
        )
    )
snapshot = serialize_session_view(
    view,
    cell_ids=cell_ids,
    script_metadata_hash=_script_metadata_hash(notebook_path),
    drop_virtual_file_outputs=True,
)
cache_path = get_session_cache_file(notebook_path)
cache_path.parent.mkdir(parents=True, exist_ok=True)
cache_path.write_text(json.dumps(snapshot, indent=2), encoding="utf-8")
`;

/**
 * @param {import("vscode").NotebookDocument} notebook
 * @param {ReturnType<typeof createTestContext>} ctx
 */
async function runAllCells(notebook, ctx) {
  const priorEndTimes = Array.from(
    { length: notebook.cellCount },
    (_, index) => notebook.cellAt(index).executionSummary?.timing?.endTime,
  );
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: 0, end: notebook.cellCount }],
    document: notebook.uri,
  });
  await ctx.waitUntil(() => {
    for (let index = 0; index < notebook.cellCount; index += 1) {
      const summary = notebook.cellAt(index).executionSummary;
      NodeAssert.strictEqual(summary?.success, true);
      NodeAssert.notStrictEqual(summary.timing?.endTime, priorEndTimes[index]);
    }
  });
}

/**
 * @param {import("vscode").NotebookDocument} notebook
 * @param {number} index
 * @param {ReturnType<typeof createTestContext>} ctx
 */
async function runCell(notebook, index, ctx) {
  const priorEndTime = notebook.cellAt(index).executionSummary?.timing?.endTime;
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: index, end: index + 1 }],
    document: notebook.uri,
  });
  await ctx.waitUntil(() => {
    const summary = notebook.cellAt(index).executionSummary;
    NodeAssert.strictEqual(summary?.success, true);
    NodeAssert.notStrictEqual(summary.timing?.endTime, priorEndTime);
  });
}

/** @param {import("vscode").Uri} notebook */
async function savedSessionPath(notebook) {
  const python = await ensureSharedVenv();
  const { stdout } = await execFile(python, [
    "-c",
    LOCATE_MARIMO_SAVED_SESSION,
    notebook.fsPath,
  ]);
  return stdout.trim();
}

/** @param {import("vscode").Uri} notebook */
async function readMarimoSavedSession(notebook) {
  const python = await ensureSharedVenv();
  const { stdout } = await execFile(python, [
    "-c",
    READ_MARIMO_SAVED_SESSION,
    notebook.fsPath,
  ]);
  return stdout;
}

/** @param {import("vscode").Uri} notebook */
async function writeMarimoSavedSession(notebook) {
  const python = await ensureSharedVenv();
  await execFile(python, ["-c", WRITE_MARIMO_SAVED_SESSION, notebook.fsPath]);
}

suite("saved session output", function () {
  this.timeout(60_000);

  test("run all writes a sidecar accepted by marimo", async function () {
    await using ctx = createTestContext();
    const uri = await ctx.writeTempFile(SOURCE);
    const notebook = await ctx.openNotebook(uri);
    await selectKernel(notebook);
    const cachePath = await savedSessionPath(uri);
    await NodeAssert.rejects(NodeFs.access(cachePath));

    await runAllCells(notebook, ctx);
    await ctx.waitUntil(async () => {
      const payload = JSON.parse(await NodeFs.readFile(cachePath, "utf8"));
      NodeAssert.strictEqual(payload.version, "1");
      NodeAssert.strictEqual(payload.cells.length, 2);
      NodeAssert.match(JSON.stringify(payload), /live output/);
      NodeAssert.match(JSON.stringify(payload), /42/);
    });
    const first = await NodeFs.readFile(cachePath, "utf8");
    const readByMarimo = await readMarimoSavedSession(uri);
    NodeAssert.match(readByMarimo, /live output/);
    NodeAssert.match(readByMarimo, /42/);

    await runAllCells(notebook, ctx);
    await ctx.waitUntil(async () =>
      NodeAssert.notStrictEqual(
        await NodeFs.readFile(cachePath, "utf8"),
        first,
      ),
    );
  });

  test("a partial run preserves untouched marimo output", async function () {
    await using ctx = createTestContext();
    const uri = await ctx.writeTempFile(SOURCE);
    await writeMarimoSavedSession(uri);
    const cachePath = await savedSessionPath(uri);
    const initial = await NodeFs.readFile(cachePath, "utf8");
    const notebook = await ctx.openNotebook(uri);
    await selectKernel(notebook);

    const before = JSON.parse(await readMarimoSavedSession(uri));
    NodeAssert.strictEqual(before[0].output, "cli first");
    NodeAssert.strictEqual(before[1].output, "cli second");

    await runCell(notebook, 1, ctx);
    await ctx.waitUntil(async () =>
      NodeAssert.notStrictEqual(
        await NodeFs.readFile(cachePath, "utf8"),
        initial,
      ),
    );

    const after = JSON.parse(await readMarimoSavedSession(uri));
    NodeAssert.strictEqual(after[0].output, "cli first");
    NodeAssert.notStrictEqual(after[1].output, "cli second");
    NodeAssert.match(after[1].output, /42/);
  });

  test("presents marimo output before starting a kernel", async function () {
    await using ctx = createTestContext();
    const uri = await ctx.writeTempFile(SOURCE);
    await writeMarimoSavedSession(uri);
    const notebook = await ctx.openNotebook(uri);
    await selectKernel(notebook);

    await ctx.waitUntil(() => {
      NodeAssert.match(cellOutputText(notebook.cellAt(0)), /cli first/);
      NodeAssert.match(cellOutputText(notebook.cellAt(1)), /cli second/);
    });
    NodeAssert.strictEqual(
      notebook.cellAt(0).executionSummary?.success,
      undefined,
    );
    NodeAssert.strictEqual(
      notebook.cellAt(1).executionSummary?.success,
      undefined,
    );

    const information = tinyspy.spyOn(
      vscode.window,
      "showInformationMessage",
      async () => undefined,
    );
    try {
      // oxlint-disable-next-line marimo/no-marimo-command-id-literals -- exercises the external VS Code seam
      await vscode.commands.executeCommand("marimo.restartKernel");
      NodeAssert.strictEqual(
        information.calls.at(-1)?.[0],
        "This notebook does not have a live kernel",
      );
    } finally {
      information.restore();
    }

    await runCell(notebook, 0, ctx);
    await ctx.waitUntil(() => {
      const output = cellOutputText(notebook.cellAt(0));
      NodeAssert.match(output, /live output/);
      NodeAssert.doesNotMatch(output, /cli first/);
    });
  });
});
