"""LSP handlers for marimo."""

from __future__ import annotations

import asyncio
import dataclasses
import importlib.metadata
import inspect
from functools import wraps
from typing import TYPE_CHECKING, Any, Callable, TypeVar, cast

import lsprotocol.types as lsp
import msgspec
from marimo._convert.converters import MarimoConvert
from marimo._runtime.requests import FunctionCallRequest
from marimo._schemas.serialization import NotebookSerialization
from marimo._server.models.models import InstantiateRequest
from marimo._utils.parse_dataclass import parse_raw
from pygls.lsp.server import LanguageServer
from pygls.uris import to_fs_path

from marimo_lsp.app_file_manager import sync_app_with_workspace
from marimo_lsp.completions import get_completions
from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    ConvertRequest,
    DebugAdapterRequest,
    DeserializeRequest,
    InterruptRequest,
    NotebookCommand,
    RunRequest,
    SerializeRequest,
    SessionCommand,
    SetUIElementValueRequest,
)
from marimo_lsp.session_manager import LspSessionManager

if TYPE_CHECKING:
    from marimo_lsp.kernel_manager import LspKernelManager

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

    # Commands
    @command(server, "marimo.run", SessionCommand[RunRequest])
    async def run(ls: LanguageServer, args: SessionCommand[RunRequest]):  # noqa: ARG001
        logger.info("marimo.run")
        session = manager.get_session(args.notebook_uri)
        if (
            session is None
            or cast("LspKernelManager", session.kernel_manager).executable
            != args.executable
        ):
            session = manager.create_session(
                server=server,
                executable=args.executable,
                notebook_uri=args.notebook_uri,
            )
            logger.info(f"Created and synced session {args.notebook_uri}")

        # We lazily instantiate the session until the first run command is sent
        # so we don't force connecting to a kernel unnecessarily
        is_instantiated = manager.is_instantiated(args.notebook_uri)
        if not is_instantiated:
            logger.info(f"Instantiating session {args.notebook_uri}")
            manager.set_instantiated(args.notebook_uri, instantiated=True)
            session.instantiate(
                InstantiateRequest(auto_run=False, object_ids=[], values=[]),
                http_request=None,
            )

        session.put_control_request(
            args.inner.as_execution_request(), from_consumer_id=None
        )
        logger.info(f"Execution request sent for {args.notebook_uri}")

    @command(
        server, "marimo.set_ui_element_value", NotebookCommand[SetUIElementValueRequest]
    )
    async def set_ui_element_value(
        ls: LanguageServer,  # noqa: ARG001
        args: NotebookCommand[SetUIElementValueRequest],
    ):
        logger.info("marimo.set_ui_element_value")
        session = manager.get_session(args.notebook_uri)
        assert session, f"No session in workspace for {args.notebook_uri}"
        session.put_control_request(args.inner, from_consumer_id=None)

    @command(
        server, "marimo.function_call_request", NotebookCommand[FunctionCallRequest]
    )
    async def function_call_request(
        ls: LanguageServer,  # noqa: ARG001
        args: NotebookCommand[FunctionCallRequest],
    ):
        logger.info("marimo.function_call_request")
        session = manager.get_session(args.notebook_uri)
        assert session, f"No session in workspace for {args.notebook_uri}"
        session.put_control_request(args.inner, from_consumer_id=None)

    @command(server, "marimo.interrupt", NotebookCommand[InterruptRequest])
    async def interrupt(
        ls: LanguageServer,  # noqa: ARG001
        args: NotebookCommand[InterruptRequest],
    ):
        logger.info(f"marimo.interrupt for {args.notebook_uri}")
        session = manager.get_session(args.notebook_uri)
        if session:
            session.try_interrupt()
            logger.info(f"Interrupt request sent for {args.notebook_uri}")
        else:
            logger.warning(f"No session found for {args.notebook_uri}")

    @command(server, "marimo.serialize", SerializeRequest)
    async def serialize(ls: LanguageServer, args: SerializeRequest):  # noqa: ARG001
        logger.info("marimo.serialize")
        ir = parse_raw(args.notebook, cls=NotebookSerialization)
        return {"source": MarimoConvert.from_ir(ir).to_py()}

    @command(server, "marimo.deserialize", DeserializeRequest)
    async def deserialize(ls: LanguageServer, args: DeserializeRequest):  # noqa: ARG001
        logger.info("marimo.deserialize")
        converter = MarimoConvert.from_py(args.source)
        return dataclasses.asdict(converter.to_ir())

    @command(server, "marimo.dap", NotebookCommand[DebugAdapterRequest])
    async def dap(ls: LanguageServer, args: NotebookCommand[DebugAdapterRequest]):
        """Handle DAP messages forwarded from VS Code extension."""
        from marimo_lsp.debug_adapter import (
            handle_debug_adapter_request,
        )

        return handle_debug_adapter_request(
            ls=ls,
            manager=manager,
            notebook_uri=args.notebook_uri,
            session_id=args.inner.session_id,
            message=args.inner.message,
        )

    @command(server, "marimo.convert", ConvertRequest)
    async def convert(ls: LanguageServer, args: ConvertRequest):
        """Convert a Python file to marimo format and create a new file."""
        logger.info("marimo.convert")

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


T = TypeVar("T", bound=msgspec.Struct)


def command(server: LanguageServer, name: str, type: type[T]) -> Callable:  # noqa: A002
    """Register LSP commands that use msgspec structs.

    Wraps pygls @server.command to automatically convert dict args to msgspec structs.
    The decorated function must have exactly 2 parameters:

    1. ls: LanguageServer
    2. params: msgspec.Struct subclass
    """

    def decorator(func: Callable[[LanguageServer, T], None]) -> Callable:
        params = list(inspect.signature(func).parameters.values())

        if len(params) != 2:  # noqa: PLR2004
            msg = (
                f"Command handler {func.__name__} must have exactly 2 parameters: "  # ty: ignore[unresolved-attribute]
                f"(ls: LanguageServer, params: msgspec.Struct)"
            )
            raise ValueError(msg)

        if asyncio.iscoroutinefunction(func):

            @server.command(name)
            @wraps(func)
            async def wrapper(ls: LanguageServer, args: dict[str, Any]) -> Any:  # noqa: ANN401
                return await func(
                    ls, msgspec.convert(args, type=type)
                )  # ty: ignore[invalid-await]

            # Override annotations to prevent cattrs from inspecting
            wrapper.__annotations__ = {}
        else:

            @server.command(name)
            @wraps(func)
            def wrapper(ls: LanguageServer, args: dict[str, Any]) -> Any:  # noqa: ANN401
                return func(ls, msgspec.convert(args, type=type))

            # Override annotations to prevent cattrs from inspecting
            wrapper.__annotations__ = {}
        return wrapper

    return decorator
