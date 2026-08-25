// @ts-check
/// <reference types="mocha" />

const NodeAssert = require("node:assert");
const NodeChildProcess = require("node:child_process");
const NodeFs = require("node:fs/promises");
const NodePath = require("node:path");
const NodeUtil = require("node:util");
const tinyspy = require("tinyspy");
const vscode = require("vscode");

const {
  cellOutputText,
  createTestContext,
  ensureSharedVenv,
  selectKernel,
} = require("./helpers.cjs");

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const SOURCE = `import marimo

app = marimo.App()


@app.cell
def _():
    import time
    print(f"live output {time.time_ns()}")
    return


if __name__ == "__main__":
    app.run()
`;

const WRITE_SAVED_SESSION = String.raw`
import json
import pathlib
import sys

sys.pycache_prefix = None

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
view.add_notification(
    CellNotification(
        cell_id=cell_ids[0],
        status="idle",
        output=CellOutput(
            channel=CellChannel.OUTPUT,
            mimetype="text/plain",
            data="saved output",
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

const READ_SAVED_SESSION = String.raw`
import json
import pathlib
import sys

import marimo
from marimo._messaging.notebook.document import NotebookDocument
from marimo._session.notebook.file_manager import AppFileManager
from marimo._session.state.serialize import (
    _script_metadata_hash,
    get_session_cache_file,
    SessionCacheKey,
    SessionCacheManager,
)
from marimo._session.state.session_view import SessionView
from marimo._utils.lists import as_list

notebook_path = pathlib.Path(sys.argv[1])
app = AppFileManager(notebook_path).app
cell_ids = tuple(app.cell_manager.cell_ids())
codes = tuple(app.cell_manager.codes())
view = SessionCacheManager(
    session_view=SessionView(),
    document=NotebookDocument([]),
    path=notebook_path,
    interval=1,
).read_session_view(
    SessionCacheKey(
        codes=codes,
        marimo_version=marimo.__version__,
        cell_ids=cell_ids,
        script_metadata_hash=_script_metadata_hash(notebook_path),
    )
)
notification = view.cell_notifications[cell_ids[0]]
print(json.dumps(str(as_list(notification.console)[0].data)))
`;

/** @param {import("vscode").NotebookDocument} notebook */
async function runFirstCell(notebook) {
  await vscode.commands.executeCommand("notebook.cell.execute", {
    ranges: [{ start: 0, end: 1 }],
    document: notebook.uri,
  });
}

suite("saved session output", function () {
  this.timeout(60_000);

  test("restores cold output without starting a kernel", async function () {
    await using ctx = createTestContext();
    const uri = await ctx.writeTempFile(SOURCE);
    const python = await ensureSharedVenv();
    await execFile(python, ["-c", WRITE_SAVED_SESSION, uri.fsPath]);

    const notebook = await ctx.openNotebook(uri);
    await selectKernel(notebook);
    await ctx.waitUntil(() =>
      NodeAssert.match(cellOutputText(notebook.cellAt(0)), /saved output/),
    );
    NodeAssert.strictEqual(
      notebook.cellAt(0).executionSummary?.success,
      undefined,
    );

    const information = tinyspy.spyOn(
      vscode.window,
      "showInformationMessage",
      async () => undefined,
    );
    try {
      // oxlint-disable-next-line marimo/no-marimo-command-id-literals -- external VS Code seam
      await vscode.commands.executeCommand("marimo.restartKernel");
      NodeAssert.strictEqual(
        information.calls.at(-1)?.[0],
        "This notebook does not have a live kernel",
      );
    } finally {
      information.restore();
    }

    await runFirstCell(notebook);
    await ctx.waitUntil(() => {
      const output = cellOutputText(notebook.cellAt(0));
      NodeAssert.match(output, /live output/);
      NodeAssert.doesNotMatch(output, /saved output/);
      NodeAssert.strictEqual(
        notebook.cellAt(0).executionSummary?.success,
        true,
      );
    });
  });

  test("writes output in a sidecar accepted by marimo", async function () {
    await using ctx = createTestContext();
    const uri = await ctx.writeTempFile(SOURCE);
    const python = await ensureSharedVenv();
    const cachePath = NodePath.join(
      NodePath.dirname(uri.fsPath),
      "__marimo__",
      "session",
      `${NodePath.basename(uri.fsPath)}.json`,
    );
    const notebook = await ctx.openNotebook(uri);
    await selectKernel(notebook);

    await runFirstCell(notebook);
    await ctx.waitUntil(async () => {
      const contents = await NodeFs.readFile(cachePath, "utf8");
      NodeAssert.match(contents, /live output/);
    });

    const { stdout } = await execFile(python, [
      "-c",
      READ_SAVED_SESSION,
      uri.fsPath,
    ]);
    NodeAssert.match(stdout, /live output/);
  });
});
