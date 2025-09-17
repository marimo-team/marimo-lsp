from __future__ import annotations

import asyncio
import re
import sys
from typing import Any, Callable

import lsprotocol.types as lsp
import pytest
import pytest_lsp
from dirty_equals import IsFloat, IsList, IsUUID
from inline_snapshot import snapshot
from pytest_lsp import ClientServerConfig, LanguageClient


def asdict(obj: Any) -> dict[str, Any]:  # noqa: ANN401
    """Recursively convert namedtuple Objects to dicts."""
    if hasattr(obj, "_asdict"):
        return {k: asdict(v) for k, v in obj._asdict().items()}
    if isinstance(obj, list):
        # Just used recursively
        return [asdict(item) for item in obj]  # pyright: ignore[reportReturnType]
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
                    lsp.NotebookCell(
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
                    lsp.NotebookCell(
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
                                lsp.NotebookCell(
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
            command="marimo.serialize",
            arguments=[{"notebook": notebook}],
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
            command="marimo.deserialize",
            arguments=[{"source": source}],
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
        }
    )


@pytest.mark.asyncio
async def test_simple_marimo_run(client: LanguageClient) -> None:
    """Test that we can collect marimo operations until cell reaches idle state."""
    code = """\
import sys

print("hello, world")
print("error message", file=sys.stderr)
x = 42\
"""

    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///exec_test.py",
                notebook_type="marimo-notebook",
                version=1,
                cells=[
                    lsp.NotebookCell(
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
            command="marimo.run",
            arguments=[
                {
                    "notebookUri": "file:///exec_test.py",
                    "executable": sys.executable,
                    "inner": {
                        "cellIds": ["cell1"],
                        "codes": [code],
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
                    "op": "update-cell-codes",
                    "cell_ids": ["cell1"],
                    "codes": [
                        """\
import sys

print("hello, world")
print("error message", file=sys.stderr)
x = 42\
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
