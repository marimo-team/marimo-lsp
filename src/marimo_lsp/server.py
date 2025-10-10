"""LSP handlers for marimo."""

from __future__ import annotations

import importlib.metadata
import typing

import lsprotocol.types as lsp
import msgspec
from marimo._convert.converters import MarimoConvert
from pygls.lsp.server import LanguageServer
from pygls.uris import to_fs_path

from marimo_lsp.api import handle_api_command
from marimo_lsp.app_file_manager import sync_app_with_workspace
from marimo_lsp.completions import get_completions
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import ApiRequest, ConvertRequest
from marimo_lsp.session_manager import LspSessionManager

logger = get_logger()


def create_server() -> LanguageServer:  # noqa: C901, PLR0915
    """Create the marimo LSP server."""
    server = LanguageServer(
        name="marimo-lsp",
        version=importlib.metadata.version("marimo-lsp"),
        notebook_document_sync=lsp.NotebookDocumentSyncOptions(
            notebook_selector=[
                lsp.NotebookDocumentFilterWithCells(
                    cells=[lsp.NotebookCellLanguage(language="python")],
                    notebook="marimo-notebook",
                ),
            ],
            save=True,
        ),
    )
    manager = LspSessionManager()

    # Lsp Features
    @server.feature(lsp.SHUTDOWN)
    def shutdown(params: None) -> None:  # noqa: ARG001
        manager.shutdown()

    @server.feature(lsp.NOTEBOOK_DOCUMENT_DID_OPEN)
    async def did_open(params: lsp.DidOpenNotebookDocumentParams) -> None:
        logger.info(f"notebookDocument/didOpen {params.notebook_document.uri}")
        session = manager.get_session(notebook_uri=params.notebook_document.uri)
        if session:
            sync_app_with_workspace(
                workspace=server.workspace,
                notebook_uri=params.notebook_document.uri,
                app=session.app_file_manager.app,
            )
            logger.info(f"Synced session {params.notebook_document.uri}")

    @server.feature(lsp.NOTEBOOK_DOCUMENT_DID_CHANGE)
    async def did_change(params: lsp.DidChangeNotebookDocumentParams) -> None:
        logger.info(f"notebookDocument/didChange {params.notebook_document.uri}")
        session = manager.get_session(notebook_uri=params.notebook_document.uri)
        if session:
            sync_app_with_workspace(
                workspace=server.workspace,
                notebook_uri=params.notebook_document.uri,
                app=session.app_file_manager.app,
            )
        logger.info(f"Synced session {params.notebook_document.uri}")

    @server.feature(lsp.NOTEBOOK_DOCUMENT_DID_SAVE)
    async def did_save(params: lsp.DidSaveNotebookDocumentParams) -> None:
        logger.info(f"notebookDocument/didSave {params.notebook_document.uri}")
        session = manager.get_session(notebook_uri=params.notebook_document.uri)
        if session:
            sync_app_with_workspace(
                workspace=server.workspace,
                notebook_uri=params.notebook_document.uri,
                app=session.app_file_manager.app,
            )
        logger.info(f"Synced session {params.notebook_document.uri}")

    @server.feature(lsp.NOTEBOOK_DOCUMENT_DID_CLOSE)
    async def did_close(params: lsp.DidCloseNotebookDocumentParams) -> None:
        logger.info(f"notebookDocument/didClose {params.notebook_document.uri}")
        # Only close untitled sessions, when closing documents...
        # Others can stay alive
        if params.notebook_document.uri.startswith("untitled:"):
            manager.close_session(params.notebook_document.uri)
            logger.info(f"Closed {params.notebook_document.uri}")

    @server.feature(
        lsp.TEXT_DOCUMENT_CODE_ACTION,
        lsp.CodeActionOptions(
            code_action_kinds=[lsp.CodeActionKind.RefactorRewrite],
            resolve_provider=False,
        ),
    )
    def code_actions(params: lsp.CodeActionParams):
        """Provide code actions for Python files to convert to marimo."""
        logger.info(f"textDocument/codeAction {params.text_document.uri}")

        actions: list[lsp.CodeAction] = []

        filename = to_fs_path(params.text_document.uri)
        if filename and filename.endswith((".py", ".ipynb")):
            actions.append(
                lsp.CodeAction(
                    title="Convert to marimo notebook",
                    kind=lsp.CodeActionKind.RefactorRewrite,
                    command=lsp.Command(
                        title="Convert to marimo notebook",
                        command="marimo.convert",
                        arguments=[{"uri": params.text_document.uri}],
                    ),
                )
            )

        return actions

    @server.feature(
        lsp.TEXT_DOCUMENT_COMPLETION,
        lsp.CompletionOptions(
            trigger_characters=["@"],
            resolve_provider=False,
        ),
    )
    def completions(ls: LanguageServer, params: lsp.CompletionParams):
        """Provide completions for marimo cells."""
        logger.info(f"textDocument/completion {params.text_document.uri}")

        return get_completions(ls, params)

    @server.command("marimo.api")
    async def api(ls: LanguageServer, params: typing.Any):  # noqa: ANN401
        """Unified API endpoint for all marimo internal methods."""
        logger.info("marimo.api")
        args = msgspec.convert(params, type=ApiRequest)
        return await handle_api_command(ls, manager, args.method, args.params)

    @server.command("marimo.convert")
    async def convert(ls: LanguageServer, params: typing.Any):  # noqa: ANN401
        """Convert a Python file to marimo format and create a new file."""
        logger.info("marimo.convert")

        args = msgspec.convert(params, type=ConvertRequest)
        text_document = ls.workspace.get_text_document(args.uri)
        filename = text_document.filename

        if filename is None:
            return

        if filename.endswith(".ipynb"):
            ir = MarimoConvert.from_ipynb(text_document.source)
            new_filename = filename.replace(".ipynb", "_mo.py")
        else:
            ir = MarimoConvert.from_non_marimo_python_script(text_document.source)
            new_filename = filename.replace(".py", "_mo.py")

        new_uri = text_document.uri.replace(filename, new_filename)
        new_text = ir.to_py()
        result = await ls.workspace_apply_edit_async(
            lsp.ApplyWorkspaceEditParams(
                label=f"converted {filename} → {new_filename}",
                edit=lsp.WorkspaceEdit(
                    document_changes=[
                        lsp.CreateFile(
                            kind="create",
                            uri=new_uri,
                            options=lsp.CreateFileOptions(
                                overwrite=False,
                                ignore_if_exists=True,
                            ),
                        ),
                        lsp.TextDocumentEdit(
                            text_document=lsp.OptionalVersionedTextDocumentIdentifier(
                                uri=new_uri,
                                version=None,
                            ),
                            edits=[
                                lsp.TextEdit(
                                    new_text=new_text,
                                    range=lsp.Range(
                                        start=lsp.Position(line=0, character=0),
                                        end=lsp.Position(line=0, character=0),
                                    ),
                                )
                            ],
                        ),
                    ],
                ),
            )
        )
        if result.applied:
            await ls.window_show_document_async(
                lsp.ShowDocumentParams(
                    uri=new_uri,
                    external=False,
                    take_focus=True,
                    selection=None,
                )
            )

    logger.info("All handlers registered successfully")

    return server
