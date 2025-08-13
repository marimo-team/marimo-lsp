"""Basic tests for marimo-lsp server using pytest-lsp."""

import lsprotocol.types as lsp
import pytest
import pytest_lsp
from inline_snapshot import snapshot
from pytest_lsp import ClientServerConfig, LanguageClient


@pytest_lsp.fixture(config=ClientServerConfig(server_command=["marimo-lsp"]))
async def client(lsp_client: LanguageClient):  # noqa: ANN201
    """Fixture to set up and tear down LSP client."""
    response = await lsp_client.initialize_session(
        lsp.InitializeParams(
            capabilities=lsp.ClientCapabilities(
                notebook_document=lsp.NotebookDocumentClientCapabilities(
                    synchronization=lsp.NotebookDocumentSyncClientCapabilities()
                )
            ),
            root_uri="file:///test/workspace",
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
                notebook_type="marimo-lsp-notebook",
                version=1,
                cells=[
                    lsp.NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///test.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///test.py#cell1",
                    language_id="python",
                    version=1,
                    text="print('hello')",
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
                notebook_type="marimo-lsp-notebook",
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

    # No exception means success


@pytest.mark.asyncio
async def test_notebook_did_save(client: LanguageClient) -> None:
    """Test saving a notebook document."""
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///test3.py",
                notebook_type="marimo-lsp-notebook",
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


@pytest.mark.asyncio
async def test_notebook_did_close(client: LanguageClient) -> None:
    """Test closing an untitled notebook document."""
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="untitled:Untitled-1",
                notebook_type="marimo-lsp-notebook",
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
    assert result["source"] == snapshot("""\
marimo app

import marimo

__generated_with = "0.14.17"
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
            "version": '0.14.17',
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
async def test_marimo_run_command(client: LanguageClient) -> None:
    """Test the marimo.run command."""
    client.notebook_document_did_open(
        lsp.DidOpenNotebookDocumentParams(
            notebook_document=lsp.NotebookDocument(
                uri="file:///test_run.py",
                notebook_type="marimo-lsp-notebook",
                version=1,
                cells=[
                    lsp.NotebookCell(
                        kind=lsp.NotebookCellKind.Code,
                        document="file:///test_run.py#cell1",
                    )
                ],
            ),
            cell_text_documents=[
                lsp.TextDocumentItem(
                    uri="file:///test_run.py#cell1",
                    language_id="python",
                    version=1,
                    text="x = 1",
                )
            ],
        ),
    )

    # Execute the run command
    await client.workspace_execute_command_async(
        lsp.ExecuteCommandParams(
            command="marimo.run",
            arguments=[
                {
                    "notebook_uri": "file:///test_run.py",
                    "cell_ids": ["cell1"],
                    "codes": ["x = 1"],
                }
            ],
        )
    )

    # No exception means the command was accepted
