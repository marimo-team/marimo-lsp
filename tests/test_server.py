from __future__ import annotations

import asyncio
import re
import shutil
import subprocess
import sys
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    import pathlib
    from collections.abc import Callable

import lsprotocol.types as lsp
import pytest
import pytest_lsp
from dirty_equals import IsFloat, IsList, IsUUID
from inline_snapshot import snapshot
from pytest_lsp import ClientServerConfig, LanguageClient


class NotebookCell(lsp.NotebookCell):
    def __init__(self, kind: lsp.NotebookCellKind, document: str) -> None:
        super().__init__(
            kind=kind,
            document=document,
            metadata=cast("lsp.LSPObject", {"stableId": document.split("#")[1]}),
        )


def asdict(obj: Any) -> dict[str, Any]:  # noqa: ANN401
    """Recursively convert namedtuple Objects to dicts."""
    if hasattr(obj, "_asdict"):
        return {k: asdict(v) for k, v in obj._asdict().items()}
    if isinstance(obj, list):
        # Just used recursively
        return [asdict(item) for item in obj]  # ty: ignore[invalid-return-type]
    if isinstance(obj, dict):
        return {k: asdict(v) for k, v in obj.items()}
    return obj


def filter_output(source: str, *replacers: Callable[[str], str]) -> str:
    """Apply one or more replacer functions to `source` in order."""
    for replacer in replacers:
        source = replacer(source)
    return source


def replace_generated_with(src: str) -> str:
    return re.sub(
        r'^(\s*__generated_with\s*=\s*)(["\'])(.*?)\2',
        r'\1"<marimo-version>"',
        src,
        flags=re.MULTILINE,
    )


@pytest_lsp.fixture(config=ClientServerConfig(server_command=["marimo-lsp"]))
async def client(lsp_client: LanguageClient):  # noqa: ANN201
    """Fixture to set up and tear down LSP client."""
    response = await lsp_client.initialize_session(
        lsp.InitializeParams(
            root_uri="file:///test/workspace",
            capabilities=lsp.ClientCapabilities(
                notebook_document=lsp.NotebookDocumentClientCapabilities(
                    synchronization=lsp.NotebookDocumentSyncClientCapabilities()
                )
            ),
        )
    )
    assert response is not None

    yield lsp_client

    await lsp_client.shutdown_session()


@pytest.mark.asyncio
async def test_server_initialization(client: LanguageClient) -> None:
    """Test that server initializes properly."""
    assert client is not None


@pytest.mark.asyncio
async def test_notebook_did_open(client: LanguageClient) -> None:
    """Test opening a notebook document."""
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///test.py",
                notebook_type="marimo-notebook",
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///test.py#cell1",
                    )
                ],
                version=1,
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///test.py#cell1",
                    language_id="python",
                    text="print('hello')",
                    version=1,
                )
            ],
        ),
    )


@pytest.mark.asyncio
async def test_notebook_did_change(client: LanguageClient) -> None:
    """Test changing a notebook document."""
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///test2.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///test2.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///test2.py#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                )
            ],
        ),
    )

    client.notebook_document_did_change(
        lsp.DidChangeNotebookDocumentParams(
            notebook_document=lsp.VersionedNotebookDocumentIdentifier(
                uri="file:///test2.py",
                version=2,
            ),
            change=lsp.NotebookDocumentChangeEvent(
                cells=lsp.NotebookDocumentCellChanges(
                    structure=lsp.NotebookDocumentCellChangeStructure(
                        array=lsp.NotebookCellArrayChange(
                            start=0,
                            delete_count=0,
                            cells=[
                                NotebookCell(
                                    kind=lsp.NotebookCellKind.Code,
                                    document="file:///test2.py#cell2",
                                )
                            ],
                        ),
                        did_open=[
                            lsp.TextDocumentItem(
                                uri="file:///test2.py#cell2",
                                language_id="python",
                                version=1,
                                text="y = 2",
                            )
                        ],
                    )
                )
            ),
        ),
    )

    # TODO: Not a great test. No exception means success
    # We should have some way of querying the graph state


@pytest.mark.asyncio
async def test_notebook_did_save(client: LanguageClient) -> None:
    """Test saving a notebook document."""
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///test3.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[],
            ),
            cell_text_documents=[],
        ),
    )

    client.notebook_document_did_save(
        lsp.DidSaveNotebookDocumentParams(
            notebook_document=lsp.NotebookDocumentIdentifier(uri="file:///test3.py")
        ),
    )

    # TODO: Not a great test. No exception means success
    # We should have some way of querying the graph state


@pytest.mark.asyncio
async def test_notebook_did_close(client: LanguageClient) -> None:
    """Test closing an untitled notebook document."""
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="untitled:Untitled-1",
                notebook_type="marimo-notebook",
                version=1,
                cells=[],
            ),
            cell_text_documents=[],
        ),
    )

    client.notebook_document_did_close(
        lsp.DidCloseNotebookDocumentParams(
            notebook_document=lsp.NotebookDocumentIdentifier(uri="untitled:Untitled-1"),
            cell_text_documents=[],
        ),
    )
    # TODO: Not a great test. No exception means success
    # We should have some way of querying the graph state


@pytest.mark.asyncio
async def test_marimo_serialize_command(client: LanguageClient) -> None:
    """Test the marimo.serialize command."""
    notebook = {
        "app": {
            "options": {},
        },
        "header": {"value": "marimo app"},
        "cells": [
            {
                "code": "import marimo as mo",
                "name": "cell1",
                "options": {},
            }
        ],
        "violations": [],
        "valid": True,
    }

    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[{"method": "serialize", "params": {"notebook": notebook}}],
        )
    )

    assert result is not None
    assert filter_output(result["source"], replace_generated_with) == snapshot("""\
marimo app

import marimo

__generated_with = "<marimo-version>"
app = marimo.App()


@app.cell
def cell1():
    import marimo as mo

    return


if __name__ == "__main__":
    app.run()
""")


@pytest.mark.asyncio
async def test_marimo_deserialize_command(client: LanguageClient) -> None:
    """Test the marimo.deserialize command."""
    source = """
import marimo

__generated_with = "0.14.17"
app = marimo.App()

@app.cell
def __():
    import marimo as mo
    return mo,

if __name__ == "__main__":
    app.run()
"""

    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[{"method": "deserialize", "params": {"source": source}}],
        )
    )

    assert result == snapshot(
        {
            "app": {
                "lineno": 0,
                "col_offset": 0,
                "end_lineno": 0,
                "end_col_offset": 0,
                "options": {},
            },
            "header": {
                "lineno": 0,
                "col_offset": 0,
                "end_lineno": 0,
                "end_col_offset": 0,
                "value": "",
            },
            "version": "0.14.17",
            "cells": [
                {
                    "lineno": 7,
                    "col_offset": 0,
                    "end_lineno": 17,
                    "end_col_offset": 38,
                    "code": "import marimo as mo",
                    "name": "__",
                    "options": {},
                    "_ast": None,
                }
            ],
            "violations": [],
            "valid": True,
            "filename": "<marimo>",
        }
    )


@pytest.mark.asyncio
async def test_marimo_get_package_list_venv_no_session(
    client: LanguageClient,
) -> None:
    """Package list with a venv source works without a live session."""
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get-package-list",
                    "params": {
                        "notebookUri": "file:///nonexistent.py",
                        "source": {"kind": "venv", "executable": sys.executable},
                        "inner": {},
                    },
                }
            ],
        )
    )

    # Endpoint is session-free; uv lists packages from the executable directly.
    # `marimo` is a runtime dep of marimo-lsp, so it must appear when listing
    # against `sys.executable`. Asserting on it catches a regression to `[]`.
    assert result is not None
    names = {p["name"] for p in result["packages"]}
    assert "marimo" in names, f"expected marimo in package list, got {names}"


@pytest.mark.asyncio
async def test_marimo_get_package_list_with_session(client: LanguageClient) -> None:
    """Test the marimo.get_package_list command with an active session."""
    # First create a session by opening a notebook and running a cell
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///package_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///package_test.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///package_test.py#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                )
            ],
        ),
    )

    # Run a cell to ensure session is created
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-cells",
                    "params": {
                        "notebookUri": "file:///package_test.py",
                        "executable": sys.executable,
                        "inner": {
                            "cellIds": ["cell1"],
                            "codes": ["x = 1"],
                        },
                    },
                }
            ],
        )
    )

    # Give the session a moment to start
    await asyncio.sleep(0.1)

    # Now get the package list
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get-package-list",
                    "params": {
                        "notebookUri": "file:///package_test.py",
                        "source": {"kind": "venv", "executable": sys.executable},
                        "inner": {},
                    },
                }
            ],
        )
    )

    # Should return a list of packages (at least some common ones should be present)
    assert result is not None
    assert "packages" in result
    packages = result["packages"]
    assert packages is not None
    assert isinstance(packages, list)
    assert len(packages) > 2  # Has more than just marimo


@pytest.mark.asyncio
async def test_execute_scratchpad_binds_code_mode_and_emits_transaction(
    client: LanguageClient,
) -> None:
    """code_mode binds inside the kernel via execute-scratchpad.

    The linchpin: `marimo._code_mode.get_context()` resolves the document
    snapshot we attach to the scratchpad command (ADR 0002), and committing a
    cell emits a `notebook-document-transaction` operation back to the client.
    """
    uri = "file:///code_mode_test.py"
    created_cell: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    def _find_created_cell(params: Any) -> Any | None:  # noqa: ANN401
        """Return the create-cell change from a code-mode transaction, if any."""
        operation = getattr(params, "operation", None)
        if getattr(operation, "op", None) != "notebook-document-transaction":
            return None
        transaction = getattr(operation, "transaction", None)
        for change in getattr(transaction, "changes", None) or []:
            if getattr(change, "type", None) == "create-cell":
                return change
        return None

    @client.feature("marimo/operation")
    def _(params: Any) -> None:  # noqa: ANN401
        change = _find_created_cell(params)
        if change is not None and not created_cell.done():
            created_cell.set_result(change)

    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri=uri,
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document=f"{uri}#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri=f"{uri}#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                )
            ],
        ),
    )

    # Create + instantiate the session so we have a live kernel.
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-cells",
                    "params": {
                        "notebookUri": uri,
                        "executable": sys.executable,
                        "inner": {"cellIds": ["cell1"], "codes": ["x = 1"]},
                    },
                }
            ],
        )
    )

    # Use code mode from inside the scratchpad to commit a new cell.
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-scratchpad",
                    "params": {
                        "notebookUri": uri,
                        "executable": sys.executable,
                        "inner": {
                            "code": (
                                "import marimo._code_mode as cm\n"
                                "async with cm.get_context() as ctx:\n"
                                "    ctx.create_cell('z = 1')\n"
                            )
                        },
                    },
                }
            ],
        )
    )

    # The code-mode commit arrives asynchronously as a notebook-document
    # transaction; wait for that specific operation rather than polling.
    change = await asyncio.wait_for(created_cell, timeout=30)

    created = asdict(change)
    # Code mode mints a fresh 4-letter CellId (mint-and-adopt — not "cell1").
    assert re.fullmatch(r"[A-Za-z]{4}", created["cellId"])
    created["cellId"] = "<minted>"
    assert created == snapshot(
        {
            "type": "create-cell",
            "cellId": "<minted>",
            "code": "z = 1",
            "name": "",
            "config": {"column": None, "disabled": False, "hide_code": True},
            "before": None,
            "after": None,
        }
    )


@pytest.mark.asyncio
async def test_code_mode_edit_cell_config_on_existing_cell(
    client: LanguageClient,
) -> None:
    """`cm.edit_cell` changing only config on an existing cell must not crash.

    Regression: the kernel app was built with cell configs as plain dicts, so
    code mode's ``existing.column`` (reading the cell's current CellConfig)
    raised ``AttributeError: 'dict' object has no attribute 'column'``. The
    config must be a real ``CellConfig``. A config-only ``edit_cell`` skips the
    read-before-write guard, so it lands directly on the config-building path.
    """
    uri = "file:///code_mode_config_test.py"
    set_config: asyncio.Future[Any] = asyncio.get_running_loop().create_future()

    @client.feature("marimo/operation")
    def _(params: Any) -> None:  # noqa: ANN401
        operation = getattr(params, "operation", None)
        if getattr(operation, "op", None) != "notebook-document-transaction":
            return
        transaction = getattr(operation, "transaction", None)
        for change in getattr(transaction, "changes", None) or []:
            if getattr(change, "type", None) == "set-config" and not set_config.done():
                set_config.set_result(change)

    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri=uri,
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document=f"{uri}#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri=f"{uri}#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                )
            ],
        ),
    )

    # Create + instantiate the session so we have a live kernel.
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-cells",
                    "params": {
                        "notebookUri": uri,
                        "executable": sys.executable,
                        "inner": {"cellIds": ["cell1"], "codes": ["x = 1"]},
                    },
                }
            ],
        )
    )

    # Edit only the config of the existing cell — this reads its current
    # CellConfig (`existing.column`), which used to be a dict and crash.
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-scratchpad",
                    "params": {
                        "notebookUri": uri,
                        "executable": sys.executable,
                        "inner": {
                            "code": (
                                "import marimo._code_mode as cm\n"
                                "async with cm.get_context() as ctx:\n"
                                "    ctx.edit_cell(ctx.cells[0].id, hide_code=True)\n"
                            )
                        },
                    },
                }
            ],
        )
    )

    change = await asyncio.wait_for(set_config, timeout=30)
    assert asdict(change) == snapshot(
        {
            "type": "set-config",
            "cellId": "cell1",
            "column": None,
            "disabled": False,
            "hideCode": True,
        }
    )


@pytest.mark.asyncio
async def test_marimo_get_dependency_tree_venv_no_session(
    client: LanguageClient,
) -> None:
    """Dependency tree with a venv source works without a live session.

    `uv tree` requires a uv-managed project; against an arbitrary venv it returns
    None. The endpoint should answer regardless of session state.
    """
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get-dependency-tree",
                    "params": {
                        "notebookUri": "file:///nonexistent.py",
                        "source": {"kind": "venv", "executable": sys.executable},
                        "inner": {},
                    },
                }
            ],
        )
    )

    assert result is not None
    assert "tree" in result


@pytest.mark.asyncio
async def test_marimo_get_dependency_tree_with_session(client: LanguageClient) -> None:
    """Test the marimo.get_dependency_tree command with an active session."""
    # First create a session by opening a notebook and running a cell
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///dep_tree_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///dep_tree_test.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///dep_tree_test.py#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                )
            ],
        ),
    )

    # Run a cell to ensure session is created
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-cells",
                    "params": {
                        "notebookUri": "file:///dep_tree_test.py",
                        "executable": sys.executable,
                        "inner": {
                            "cellIds": ["cell1"],
                            "codes": ["x = 1"],
                        },
                    },
                }
            ],
        )
    )

    # Give the session a moment to start
    await asyncio.sleep(0.1)

    # Now get the dependency tree
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get-dependency-tree",
                    "params": {
                        "notebookUri": "file:///dep_tree_test.py",
                        "source": {"kind": "venv", "executable": sys.executable},
                        "inner": {},
                    },
                }
            ],
        )
    )

    # Should return a tree or None
    assert result is not None
    assert "tree" in result
    tree = result["tree"]
    assert tree is not None
    assert "name" in tree
    assert "version" in tree
    assert "tags" in tree
    assert "dependencies" in tree
    assert len(tree["dependencies"]) > 2  # Has more than just marimo


def _build_local_script_fixture(tmp_path: pathlib.Path) -> pathlib.Path:
    """Build a self-contained PEP 723 script that depends on a local package.

    Using a local `foo` package instead of a real PyPI dep keeps the test
    deterministic and offline-friendly. `uv init --lib` produces a minimal
    hatchling-backed package; `uv add --script` writes the path dep into the
    script's inline metadata.
    """
    uv = shutil.which("uv")
    assert uv is not None, "uv must be on PATH for this test"

    pkg_dir = tmp_path / "foo"
    py_version = f"{sys.version_info.major}.{sys.version_info.minor}"
    subprocess.run(  # noqa: S603
        [uv, "init", "--lib", "--python", py_version, str(pkg_dir)],
        check=True,
        capture_output=True,
    )

    script = tmp_path / "sandbox_script.py"
    script.write_text(
        "# /// script\n"
        f'# requires-python = ">={py_version}"\n'
        "# dependencies = []\n"
        "# ///\n"
        "import foo  # noqa: F401\n",
    )
    subprocess.run(  # noqa: S603
        [uv, "add", "--script", str(script), str(pkg_dir)],
        check=True,
        capture_output=True,
    )
    return script


@pytest.mark.asyncio
async def test_marimo_get_dependency_tree_script_source(
    client: LanguageClient, tmp_path: pathlib.Path
) -> None:
    """Dependency tree with a script source uses PEP 723 metadata.

    Covers the original sandbox-panel-empty bug (#567): a notebook with a
    PEP 723 header gets its tree resolved via `uv tree --script <file>`
    without requiring a kernel session.
    """
    script = _build_local_script_fixture(tmp_path)
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get-dependency-tree",
                    "params": {
                        "notebookUri": script.as_uri(),
                        "source": {"kind": "script"},
                        "inner": {},
                    },
                }
            ],
        )
    )

    assert result is not None
    tree = result["tree"]
    assert tree is not None, "Expected uv tree --script to return a real tree"
    top_level_names = {dep["name"] for dep in tree["dependencies"]}
    assert "foo" in top_level_names, (
        f"Expected local 'foo' package in top-level deps, got {top_level_names}"
    )


@pytest.mark.asyncio
async def test_marimo_get_dependency_tree_script_no_pep723(
    client: LanguageClient, tmp_path: pathlib.Path
) -> None:
    """A script without PEP 723 metadata returns `tree=None`, not an error.

    Pinning down the contract so the TS-side error path (the `script` variant
    has no fallback) stays meaningful — if uv can't resolve a tree, we want a
    structured `None` rather than a thrown exception.
    """
    script = tmp_path / "plain_script.py"
    script.write_text("print('no metadata')\n")

    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get-dependency-tree",
                    "params": {
                        "notebookUri": script.as_uri(),
                        "source": {"kind": "script"},
                        "inner": {},
                    },
                }
            ],
        )
    )

    assert result == {"tree": None}


@pytest.mark.asyncio
async def test_marimo_get_package_list_script_source(
    client: LanguageClient, tmp_path: pathlib.Path
) -> None:
    """Package list with a script source flattens the script's tree.

    Without this, a ScriptSource request would silently `uv pip list` against
    the LSP's own Python — listing the wrong env entirely.
    """
    script = _build_local_script_fixture(tmp_path)
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get-package-list",
                    "params": {
                        "notebookUri": script.as_uri(),
                        "source": {"kind": "script"},
                        "inner": {},
                    },
                }
            ],
        )
    )

    assert result is not None
    names = {p["name"] for p in result["packages"]}
    assert "foo" in names, f"expected local 'foo' in flattened script list, got {names}"


@pytest.mark.asyncio
async def test_simple_marimo_run(client: LanguageClient) -> None:
    """Test that we can collect marimo operations until cell reaches idle state."""
    code = """\
import sys

print("hello, world")
print("error message", file=sys.stderr)
x = 42
x\
"""

    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///exec_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///exec_test.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///exec_test.py#cell1",
                    language_id="python",
                    version=1,
                    text=code,
                )
            ],
        ),
    )

    messages = []
    completion_event = asyncio.Event()

    @client.feature("marimo/operation")
    async def on_marimo_operation(params: Any) -> None:  # noqa: ANN401
        # pygls dynamically makes an `Object` named tuple which makes snapshotting hard
        # we just convert to a regular dict here for snapshotting
        messages.append(asdict(params))
        if params.operation.op == "completed-run":
            # `completed-run` fires before the kernel finishes emitting
            # trailing notifications (variables, remove-ui-elements, etc).
            # Wait a beat so the snapshot captures the full sequence.
            await asyncio.sleep(0.1)
            completion_event.set()

    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-cells",
                    "params": {
                        "notebookUri": "file:///exec_test.py",
                        "executable": sys.executable,
                        "inner": {
                            "cellIds": ["cell1"],
                            "codes": [code],
                        },
                    },
                }
            ],
        )
    )

    await asyncio.wait_for(completion_event.wait(), timeout=5.0)
    assert messages == snapshot(
        [
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "variables",
                    "variables": IsList(
                        {
                            "name": "x",
                            "declared_by": ["cell1"],
                            "used_by": [],
                        },
                        {
                            "name": "sys",
                            "declared_by": ["cell1"],
                            "used_by": [],
                        },
                        check_order=False,
                    ),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "notebook-document-transaction",
                    "transaction": {
                        "changes": [{"type": "reorder-cells", "cellIds": ["cell1"]}],
                        "source": "kernel",
                        "version": None,
                    },
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": None,
                    "stale_inputs": True,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run", "run_id": None},
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "variables",
                    "variables": IsList(
                        {"name": "sys", "declared_by": ["cell1"], "used_by": []},
                        {"name": "x", "declared_by": ["cell1"], "used_by": []},
                        check_order=False,
                    ),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": "queued",
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": None,
                    "stale_inputs": False,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "remove-ui-elements", "cell_id": "cell1"},
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": [],
                    "status": "running",
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "variable-values",
                    "variables": IsList(
                        {"name": "sys", "value": "sys", "datatype": "module"},
                        {"name": "x", "value": "42", "datatype": "int"},
                        check_order=False,
                    ),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": {
                        "channel": "output",
                        "mimetype": "text/html",
                        "data": "<pre class='text-xs'>42</pre>",
                        "timestamp": IsFloat(),
                    },
                    "console": None,
                    "status": None,
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": {
                        "channel": "stdout",
                        "mimetype": "text/plain",
                        "data": "hello, world\n",
                        "timestamp": IsFloat(),
                    },
                    "status": None,
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": {
                        "channel": "stderr",
                        "mimetype": "text/plain",
                        "data": "error message\n",
                        "timestamp": IsFloat(),
                    },
                    "status": None,
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": "idle",
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run", "run_id": None},
            },
        ]
    )


@pytest.mark.asyncio
async def test_marimo_run_with_ancestor_cell(client: LanguageClient) -> None:
    """Test that we can collect marimo operations until cell reaches idle state."""
    code_x = """x = 42"""
    code_y = """print(x)"""

    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///exec_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///exec_test.py#cell1",
                    ),
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///exec_test.py#cell2",
                    ),
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///exec_test.py#cell1",
                    language_id="python",
                    version=1,
                    text=code_x,
                ),
                lsp.TextDocumentItem(
                    uri="file:///exec_test.py#cell2",
                    language_id="python",
                    version=1,
                    text=code_y,
                ),
            ],
        ),
    )

    messages = []
    completion_event = asyncio.Event()

    @client.feature("marimo/operation")
    async def on_marimo_operation(params: Any) -> None:  # noqa: ANN401
        # pygls dynamically makes an `Object` named tuple which makes snapshotting hard
        # we just convert to a regular dict here for snapshotting
        messages.append(asdict(params))
        if params.operation.op == "completed-run":
            # `completed-run` fires before the kernel finishes emitting
            # trailing notifications (variables, remove-ui-elements, etc).
            # Wait a beat so the snapshot captures the full sequence.
            await asyncio.sleep(0.1)
            completion_event.set()

    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-cells",
                    "params": {
                        "notebookUri": "file:///exec_test.py",
                        "executable": sys.executable,
                        # Just run cell_y, and cell_x should be run automatically
                        "inner": {
                            "cellIds": ["cell2"],
                            "codes": [code_y],
                        },
                    },
                }
            ],
        )
    )

    await asyncio.wait_for(completion_event.wait(), timeout=5.0)
    assert messages == snapshot(
        [
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "variables",
                    "variables": [
                        {
                            "name": "x",
                            "declared_by": ["cell1"],
                            "used_by": ["cell2"],
                        }
                    ],
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "notebook-document-transaction",
                    "transaction": {
                        "changes": [
                            {"type": "reorder-cells", "cellIds": ["cell1", "cell2"]}
                        ],
                        "source": "kernel",
                        "version": None,
                    },
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": None,
                    "stale_inputs": True,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell2",
                    "output": None,
                    "console": None,
                    "status": None,
                    "stale_inputs": True,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run", "run_id": None},
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "variables",
                    "variables": [
                        {
                            "name": "x",
                            "declared_by": ["cell1"],
                            "used_by": ["cell2"],
                        }
                    ],
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": "queued",
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": None,
                    "stale_inputs": False,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell2",
                    "output": None,
                    "console": None,
                    "status": "queued",
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell2",
                    "output": None,
                    "console": None,
                    "status": None,
                    "stale_inputs": False,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "remove-ui-elements", "cell_id": "cell1"},
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "remove-ui-elements", "cell_id": "cell2"},
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": [],
                    "status": "running",
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "variable-values",
                    "variables": [{"name": "x", "value": "42", "datatype": "int"}],
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": {
                        "channel": "output",
                        "mimetype": "text/plain",
                        "data": "",
                        "timestamp": IsFloat(),
                    },
                    "console": None,
                    "status": None,
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell1",
                    "output": None,
                    "console": None,
                    "status": "idle",
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell2",
                    "output": None,
                    "console": [],
                    "status": "running",
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell2",
                    "output": {
                        "channel": "output",
                        "mimetype": "text/plain",
                        "data": "",
                        "timestamp": IsFloat(),
                    },
                    "console": None,
                    "status": None,
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell2",
                    "output": None,
                    "console": {
                        "channel": "stdout",
                        "mimetype": "text/plain",
                        "data": "42\n",
                        "timestamp": IsFloat(),
                    },
                    "status": None,
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "cell2",
                    "output": None,
                    "console": None,
                    "status": "idle",
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run", "run_id": None},
            },
        ]
    )


@pytest.mark.asyncio
async def test_incremental_graph_text_change(client: LanguageClient) -> None:
    """Test that changing cell text updates the graph incrementally."""
    variables_operations = []
    open_event = asyncio.Event()

    @client.feature("marimo/operation")
    async def on_operation(params: Any) -> None:  # noqa: ANN401
        if params.operation.op == "variables":
            variables_operations.append(asdict(params))
            open_event.set()

    # Open notebook with two cells
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///incremental_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///incremental_test.py#cell1",
                    ),
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///incremental_test.py#cell2",
                    ),
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///incremental_test.py#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                ),
                lsp.TextDocumentItem(
                    uri="file:///incremental_test.py#cell2",
                    language_id="python",
                    version=1,
                    text="y = x + 1",
                ),
            ],
        ),
    )

    await asyncio.wait_for(open_event.wait(), timeout=2.0)
    assert variables_operations == snapshot(
        [
            {
                "notebookUri": "file:///incremental_test.py",
                "operation": {
                    "op": "variables",
                    "variables": [
                        {
                            "name": "x",
                            "declared_by": ["cell1"],
                            "used_by": ["cell2"],
                        },
                        {
                            "name": "y",
                            "declared_by": ["cell2"],
                            "used_by": [],
                        },
                    ],
                },
            }
        ]
    )


@pytest.mark.asyncio
async def test_cell_addition(client: LanguageClient) -> None:
    """Test that adding a cell updates the graph correctly."""
    variables_operations = []
    open_event = asyncio.Event()

    @client.feature("marimo/operation")
    async def on_operation(params: Any) -> None:  # noqa: ANN401
        if params.operation.op == "variables":
            variables_operations.append(asdict(params))
            open_event.set()

    # Open with one cell
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///addition_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///addition_test.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///addition_test.py#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                )
            ],
        ),
    )

    # Wait for initial variables operation
    await asyncio.wait_for(open_event.wait(), timeout=2.0)
    assert variables_operations == snapshot(
        [
            {
                "notebookUri": "file:///addition_test.py",
                "operation": {
                    "op": "variables",
                    "variables": [
                        {
                            "name": "x",
                            "declared_by": ["cell1"],
                            "used_by": [],
                        }
                    ],
                },
            }
        ]
    )

    # Reset event for cell addition
    open_event.clear()

    # Add a second cell
    client.notebook_document_did_change(
        lsp.DidChangeNotebookDocumentParams(
            notebook_document=lsp.VersionedNotebookDocumentIdentifier(
                uri="file:///addition_test.py", version=2
            ),
            change=lsp.NotebookDocumentChangeEvent(
                cells=lsp.NotebookDocumentCellChanges(
                    structure=lsp.NotebookDocumentCellChangeStructure(
                        array=lsp.NotebookCellArrayChange(
                            start=1,
                            delete_count=0,
                            cells=[
                                NotebookCell(
                                    kind=lsp.NotebookCellKind.Code,
                                    document="file:///addition_test.py#cell2",
                                )
                            ],
                        ),
                        did_open=[
                            lsp.TextDocumentItem(
                                uri="file:///addition_test.py#cell2",
                                language_id="python",
                                version=1,
                                text="y = x + 1",
                            )
                        ],
                    )
                )
            ),
        ),
    )

    # Graph should be marked stale, but NOT published (lazy publishing)
    # So we should still have only 1 operation
    await asyncio.sleep(0.1)  # Give it time to process

    # Now request diagnostics - should publish because graph is stale
    client.text_document_diagnostic(
        lsp.DocumentDiagnosticParams(
            text_document=lsp.TextDocumentIdentifier(
                uri="file:///addition_test.py#cell1"
            )
        )
    )

    await asyncio.wait_for(open_event.wait(), timeout=2.0)
    assert variables_operations == snapshot(
        [
            {
                "notebookUri": "file:///addition_test.py",
                "operation": {
                    "op": "variables",
                    "variables": [
                        {
                            "name": "x",
                            "declared_by": ["cell1"],
                            "used_by": [],
                        }
                    ],
                },
            },
            {
                "notebookUri": "file:///addition_test.py",
                "operation": {
                    "op": "variables",
                    "variables": [
                        {
                            "name": "x",
                            "declared_by": ["cell1"],
                            "used_by": ["cell2"],
                        },
                        {
                            "name": "y",
                            "declared_by": ["cell2"],
                            "used_by": [],
                        },
                    ],
                },
            },
        ]
    )


@pytest.mark.asyncio
async def test_scratchpad_execution(client: LanguageClient) -> None:
    """Test that scratchpad executes code outside the dependency graph."""
    # First, open a notebook with a cell (required to have a session)
    notebook_code = "x = 10"
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///scratch_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///scratch_test.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///scratch_test.py#cell1",
                    language_id="python",
                    version=1,
                    text=notebook_code,
                )
            ],
        ),
    )

    # Track state for both cell execution and scratchpad
    cell_completion_event = asyncio.Event()
    scratch_messages: list[dict] = []
    scratch_completion_event = asyncio.Event()
    waiting_for_scratch = False

    @client.feature("marimo/operation")
    async def on_marimo_operation(params: Any) -> None:  # noqa: ANN401
        nonlocal waiting_for_scratch
        msg = asdict(params)
        op = msg.get("operation", {})

        # Handle cell completion (kernel startup)
        if op.get("op") == "completed-run" and not waiting_for_scratch:
            # `completed-run` fires before trailing notifications drain.
            await asyncio.sleep(0.1)
            cell_completion_event.set()
            return

        # Handle scratchpad operations
        if op.get("op") == "cell-op" and op.get("cell_id") == "__scratch__":
            scratch_messages.append(msg)
            # Scratchpad completes when status is "idle"
            if op.get("status") == "idle":
                await asyncio.sleep(0.1)
                scratch_completion_event.set()

    # Execute a cell to start the kernel session
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-cells",
                    "params": {
                        "notebookUri": "file:///scratch_test.py",
                        "executable": sys.executable,
                        "inner": {
                            "cellIds": ["cell1"],
                            "codes": [notebook_code],
                        },
                    },
                }
            ],
        )
    )

    # Wait for the cell execution to complete (kernel is now running)
    await asyncio.wait_for(cell_completion_event.wait(), timeout=10.0)

    # Now switch to waiting for scratch operations
    waiting_for_scratch = True

    # Execute scratchpad code
    scratchpad_code = """\
y = 42
print("scratchpad output")
y\
"""
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-scratchpad",
                    "params": {
                        "notebookUri": "file:///scratch_test.py",
                        "executable": sys.executable,
                        "inner": {
                            "code": scratchpad_code,
                        },
                    },
                }
            ],
        )
    )

    await asyncio.wait_for(scratch_completion_event.wait(), timeout=5.0)
    assert scratch_messages == snapshot(
        [
            {
                "notebookUri": "file:///scratch_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "__scratch__",
                    "output": None,
                    "console": None,
                    "status": "queued",
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///scratch_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "__scratch__",
                    "output": None,
                    "console": [],
                    "status": "running",
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///scratch_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "__scratch__",
                    "output": {
                        "channel": "output",
                        "mimetype": "text/html",
                        "data": "<pre class='text-xs'>42</pre>",
                        "timestamp": IsFloat(),
                    },
                    "console": None,
                    "status": None,
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///scratch_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "__scratch__",
                    "output": None,
                    "console": {
                        "channel": "stdout",
                        "mimetype": "text/plain",
                        "data": "scratchpad output\n",
                        "timestamp": IsFloat(),
                    },
                    "status": None,
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///scratch_test.py",
                "operation": {
                    "op": "cell-op",
                    "cell_id": "__scratch__",
                    "output": None,
                    "console": None,
                    "status": "idle",
                    "stale_inputs": None,
                    "run_id": None,
                    "timestamp": IsFloat(),
                },
            },
        ]
    )


@pytest.mark.asyncio
async def test_scratchpad_creates_session_when_missing(
    client: LanguageClient,
) -> None:
    """execute-scratchpad creates the session on demand when none exists.

    The notebook is opened but never run, so no session exists yet. Running
    scratchpad code with an ``executable`` should behave like the user running
    a cell: create the session, start the kernel, and run the code — emitting
    the scratch cell's output — rather than hanging waiting for a completed-run
    that a missing session could never send.
    """
    uri = "file:///create_on_scratch.py"
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri=uri,
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document=f"{uri}#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri=f"{uri}#cell1",
                    language_id="python",
                    version=1,
                    text="x = 10",
                )
            ],
        ),
    )

    scratch_messages: list[dict] = []
    scratch_done = asyncio.Event()

    @client.feature("marimo/operation")
    async def on_marimo_operation(params: Any) -> None:  # noqa: ANN401
        msg = asdict(params)
        op = msg.get("operation", {})
        if op.get("op") == "cell-op" and op.get("cell_id") == "__scratch__":
            scratch_messages.append(msg)
            if op.get("status") == "idle":
                await asyncio.sleep(0.1)
                scratch_done.set()

    # No cell was ever executed, so there is no session for this notebook yet.
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "execute-scratchpad",
                    "params": {
                        "notebookUri": uri,
                        "executable": sys.executable,
                        "inner": {"code": "print('from new session')"},
                    },
                }
            ],
        )
    )

    # Must not hang: the session is created and the code runs.
    await asyncio.wait_for(scratch_done.wait(), timeout=10.0)

    stdout = "".join(
        op["operation"]["console"]["data"]
        for op in scratch_messages
        if isinstance(op["operation"].get("console"), dict)
        and op["operation"]["console"].get("channel") == "stdout"
    )
    assert stdout == snapshot("from new session\n")
