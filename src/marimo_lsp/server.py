"""LSP handlers for marimo."""

from __future__ import annotations

import dataclasses
import importlib.metadata

import lsprotocol.types as lsp
from marimo._convert.converters import MarimoConvert
from marimo._schemas.serialization import (
    AppInstantiation,
    CellDef,
    Header,
    NotebookSerialization,
    Violation,
)
from pygls.lsp.server import LanguageServer

from marimo_lsp.app_file_manager import sync_app_with_workspace
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    DeserializeRequest,
    RunRequest,
    SerializeRequest,
    SetUIElementValueRequest,
    converter_factory,
)
from marimo_lsp.session_manager import LspSessionManager

logger = get_logger()


def create_server() -> LanguageServer:  # noqa: C901
    """Create the marimo LSP server."""
    server = LanguageServer(
        name="marimo-lsp",
        version=importlib.metadata.version("marimo-lsp"),
        notebook_document_sync=lsp.NotebookDocumentSyncOptions(
            notebook_selector=[
                lsp.NotebookDocumentFilterWithCells(
                    cells=[lsp.NotebookCellLanguage(language="python")],
                    notebook="marimo-lsp-notebook",
                ),
            ],
            save=True,
        ),
        converter_factory=converter_factory,
    )
    manager = LspSessionManager()

    @server.feature(lsp.SHUTDOWN)
    def shutdown(params: None) -> None:  # noqa: ARG001
        manager.shutdown()

    @server.feature(lsp.NOTEBOOK_DOCUMENT_DID_OPEN)
    async def did_open(params: lsp.DidOpenNotebookDocumentParams) -> None:
        logger.info(f"notebookDocument/didOpen {params.notebook_document.uri}")
        session = manager.get_session(notebook_uri=params.notebook_document.uri)
        if session is None:
            session = manager.create_session(
                server=server, notebook_uri=params.notebook_document.uri
            )
            logger.info(f"Created and synced session {params.notebook_document.uri}")
        else:
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
        assert session, f"No session in workspace for {params.notebook_document.uri}"
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
        assert session, f"No session in workspace for {params.notebook_document.uri}"
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

    @server.command("marimo.run")
    async def run(ls: LanguageServer, args: RunRequest):  # noqa: ARG001
        logger.info("marimo.run")
        session = manager.get_session(args.notebook_uri)
        assert session, f"No session in workspace for {args.notebook_uri}"
        session.put_control_request(
            args.into_marimo().as_execution_request(), from_consumer_id=None
        )
        logger.info(f"Execution request sent for {args.notebook_uri}")

    @server.command("marmo.kernel.set_ui_element_value")
    async def set_ui_element_value(ls: LanguageServer, args: SetUIElementValueRequest):  # noqa: ARG001
        logger.info("marimo.kernel.set_ui_element_value")
        session = manager.get_session(args.notebook_uri)
        assert session, f"No session in workspace for {args.notebook_uri}"
        session.put_control_request(args.into_marimo(), from_consumer_id=None)

    @server.command("marimo.serialize")
    async def serialize(args: SerializeRequest):
        logger.info("marimo.serialize")
        raw = args.notebook
        ir = NotebookSerialization(
            app=AppInstantiation(**raw["app"]),
            header=Header(**(raw.get("header") or {})),
            version=raw.get("version", None),
            cells=[CellDef(**cell) for cell in raw["cells"]],
            violations=[Violation(**v) for v in raw["violations"]],
            valid=raw["valid"],
        )
        return {"source": MarimoConvert.from_ir(ir).to_py()}

    @server.command("marimo.deserialize")
    async def deserialize(args: DeserializeRequest):
        logger.info("marimo.deserialize")
        converter = MarimoConvert.from_py(args.source)
        return dataclasses.asdict(converter.to_ir())

    logger.info("All handlers registered successfully")

    return server
