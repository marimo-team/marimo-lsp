from __future__ import annotations

import asyncio
import re
import sys
from typing import Any, Callable, cast

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
async def test_marimo_get_package_list_no_session(client: LanguageClient) -> None:
    """Test the marimo.get_package_list command when no session exists."""
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get_package_list",
                    "params": {
                        "notebookUri": "file:///nonexistent.py",
                        "executable": sys.executable,
                        "inner": {},
                    },
                }
            ],
        )
    )

    assert result == {"packages": []}


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
                    "method": "run",
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
                    "method": "get_package_list",
                    "params": {
                        "notebookUri": "file:///package_test.py",
                        "executable": sys.executable,
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
async def test_marimo_get_dependency_tree_no_session(client: LanguageClient) -> None:
    """Test the marimo.get_dependency_tree command when no session exists."""
    result = await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "get_dependency_tree",
                    "params": {
                        "notebookUri": "file:///nonexistent.py",
                        "executable": sys.executable,
                        "inner": {},
                    },
                }
            ],
        )
    )

    assert result == {"tree": None}


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
                    "method": "run",
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
                    "method": "get_dependency_tree",
                    "params": {
                        "notebookUri": "file:///dep_tree_test.py",
                        "executable": sys.executable,
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
            # FIXME: stdin/stdout are flushed every 10ms, so wait 100ms to ensure
            # all related events. The frontend uses the same workaround.
            await asyncio.sleep(0.1)
            completion_event.set()

    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "run",
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
                    "op": "update-cell-codes",
                    "cell_ids": ["cell1"],
                    "codes": [
                        """\
import sys

print("hello, world")
print("error message", file=sys.stderr)
x = 42
x\
"""
                    ],
                    "code_is_stale": False,
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "focus-cell", "cell_id": "cell1"},
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
                    "serialization": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run"},
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                        "data": "<pre style='font-size: 12px'>42</pre>",
                        "timestamp": IsFloat(),
                    },
                    "console": None,
                    "status": None,
                    "stale_inputs": None,
                    "run_id": IsUUID(),
                    "serialization": None,
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
                    "serialization": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run"},
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
                    "serialization": None,
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
                    "serialization": None,
                    "timestamp": IsFloat(),
                },
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
            # FIXME: stdin/stdout are flushed every 10ms, so wait 100ms to ensure
            # all related events. The frontend uses the same workaround.
            await asyncio.sleep(0.1)
            completion_event.set()

    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.api",
            arguments=[
                {
                    "method": "run",
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
                    "op": "update-cell-codes",
                    "cell_ids": ["cell2"],
                    "codes": ["print(x)"],
                    "code_is_stale": False,
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "focus-cell", "cell_id": "cell2"},
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
                    "serialization": None,
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
                    "serialization": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run"},
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
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
                    "serialization": None,
                    "timestamp": IsFloat(),
                },
            },
            {
                "notebookUri": "file:///exec_test.py",
                "operation": {"op": "completed-run"},
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
                    "serialization": None,
                    "timestamp": IsFloat(),
                },
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
