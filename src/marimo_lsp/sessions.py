# Copyright 2026 Marimo. All rights reserved.

"""Live kernel sessions owned by the language server."""

from __future__ import annotations

import json
import queue
import threading
from typing import TYPE_CHECKING, cast
from uuid import uuid4

from marimo._config.manager import get_default_config_manager
from marimo._ipc import QueueManager as IpcQueues
from marimo._runtime.commands import (
    CodeCompletionCommand,
    CommandMessage,
    CreateNotebookCommand,
    ExecuteCellCommand,
    HTTPRequest,
    UpdateUIElementCommand,
    UpdateUserConfigCommand,
)
from marimo._session.managers import IPCQueueManagerImpl as IpcQueueManager
from marimo._session.state.session_view import SessionView

from marimo_lsp.app_file_manager import LspAppFileManager, sync_app_with_workspace
from marimo_lsp.kernel_manager import LspKernelManager
from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
    from collections.abc import Iterator

    from marimo._ast.app import InternalApp
    from marimo._config.config import (
        MarimoConfig,
        PartialMarimoConfig,
        RuntimeConfig,
    )
    from marimo._config.manager import MarimoConfigManager
    from marimo._messaging.types import KernelMessage
    from marimo._session.requests import InstantiateNotebookRequest
    from marimo._session.types import QueueManager
    from marimo._types.ids import ConsumerId
    from pygls.lsp.server import LanguageServer
    from pygls.workspace import Workspace


logger = get_logger()


class _OperationSink:
    """Forward operations to the single attached language-server client."""

    def __init__(self, server: LanguageServer, notebook_uri: str) -> None:
        self._server = server
        self._notebook_uri = notebook_uri
        self._attached = True

    @property
    def attached(self) -> bool:
        return self._attached

    def attach(self) -> None:
        self._attached = True
        logger.info(f"Attached client for {self._notebook_uri}")

    def detach(self) -> None:
        self._attached = False
        logger.info(f"Detached client for {self._notebook_uri}")

    def notify(self, message: KernelMessage) -> None:
        if not self._attached:
            return

        try:
            operation = json.loads(message)
            self._server.protocol.notify(
                "marimo/operation",
                {"notebookUri": self._notebook_uri, "operation": operation},
            )
            logger.debug(
                f"Forwarded {operation.get('op', 'unknown')} to {self._notebook_uri}"
            )
        except Exception:
            logger.exception("Error forwarding kernel message")


class Session:
    """One live marimo kernel session and its client attachment."""

    def __init__(  # noqa: PLR0913
        self,
        *,
        initialization_id: str,
        notebook_uri: str,
        operation_sink: _OperationSink,
        queue_manager: QueueManager,
        kernel_manager: LspKernelManager,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
    ) -> None:
        self.initialization_id = initialization_id
        self._notebook_uri = notebook_uri
        self._app_file_manager = app_file_manager
        self._config_manager = config_manager
        # Used by exporters and scratchpad snapshots.
        self.session_view = SessionView()

        self._operation_sink = operation_sink
        self._queue_manager = queue_manager
        self._kernel_manager = kernel_manager
        self._closed = False
        self._listener_thread: threading.Thread | None = None
        self._runtime_config = config_manager.get_config(hide_secrets=False)

        try:
            self._kernel_manager.start_kernel()
        except Exception:
            # Session construction transfers ownership of the IPC transport.
            # Release it when startup fails before a Session can be returned.
            if self._kernel_manager.kernel_task is not None:
                try:
                    self._kernel_manager.close_kernel()
                except Exception:
                    logger.exception("Error closing partially started kernel")
            try:
                self._queue_manager.close_queues()
            except Exception:
                logger.exception("Error closing queues after failed kernel start")
            raise
        self._start_message_listener()
        logger.info(f"Started session {initialization_id}")

    @property
    def executable(self) -> str:
        """Return the Python executable used by this session."""
        return self._kernel_manager.executable

    @property
    def attached(self) -> bool:
        """Return whether operations are forwarded to the notebook client."""
        return self._operation_sink.attached

    @property
    def app(self) -> InternalApp:
        """Return the live marimo app state."""
        return self._app_file_manager.app

    @property
    def filename(self) -> str | None:
        """Return the notebook filename, when it has one."""
        return self._app_file_manager.filename

    def get_config(self, *, hide_secrets: bool = True) -> MarimoConfig:
        """Return this session's configured marimo settings."""
        return self._config_manager.get_config(hide_secrets=hide_secrets)

    def save_config(self, config: PartialMarimoConfig) -> MarimoConfig:
        """Persist configuration and apply its effective runtime value."""
        updated = self._config_manager.save_config(config)
        self.update_runtime_config(updated)
        return updated

    def sync(self, workspace: Workspace) -> None:
        """Synchronize the live app with the current notebook document."""
        sync_app_with_workspace(
            workspace=workspace,
            notebook_uri=self._notebook_uri,
            app=self._app_file_manager.app,
        )

    def _start_message_listener(self) -> None:
        """Start the background kernel-message listener."""

        def listen() -> None:
            stream_queue = self._queue_manager.stream_queue
            if stream_queue is None:
                return
            while not self._closed:
                try:
                    msg = stream_queue.get(timeout=0.1)
                    if msg is None:
                        return
                    self.session_view.add_raw_notification(msg)
                    self._operation_sink.notify(msg)
                except queue.Empty:
                    continue

        self._listener_thread = threading.Thread(target=listen, daemon=True)
        self._listener_thread.start()

    def put_input(self, text: str) -> None:
        """Send user input to the kernel's stdin."""
        self._queue_manager.input_queue.put(text)

    def try_interrupt(self) -> None:
        """Interrupt the kernel."""
        self._kernel_manager.interrupt_kernel()

    def put_control_request(
        self,
        request: CommandMessage,
        from_consumer_id: ConsumerId | None,
    ) -> None:
        """Send a command to the kernel."""
        del from_consumer_id
        if not isinstance(request, CodeCompletionCommand):
            self.session_view.add_control_request(request)
        self._queue_manager.put_control_request(request)

    def _effective_runtime(self, config: MarimoConfig) -> MarimoConfig:
        if self.attached:
            return config

        runtime = cast("RuntimeConfig", config.get("runtime", {}))
        return cast(
            "MarimoConfig",
            {**config, "runtime": {**runtime, "auto_reload": "off"}},
        )

    def update_runtime_config(self, config: MarimoConfig) -> None:
        """Apply configuration subject to this session's attachment policy."""
        self._runtime_config = config
        self.put_control_request(
            UpdateUserConfigCommand(config=self._effective_runtime(config)),
            from_consumer_id=None,
        )

    def detach(self) -> None:
        """Detach the client and pause auto-reload without stopping the kernel."""
        if not self.attached:
            return

        self._operation_sink.detach()
        self.update_runtime_config(self._runtime_config)

    def attach(self) -> None:
        """Reattach the client and restore the configured auto-reload mode."""
        if self.attached:
            return

        self._operation_sink.attach()
        self.update_runtime_config(self._runtime_config)

    def instantiate(
        self,
        request: InstantiateNotebookRequest,
        *,
        http_request: HTTPRequest | None,
    ) -> None:
        """Instantiate the notebook."""
        codes = request.codes or self._app_file_manager.app.cell_manager.code_map()

        del http_request  # Unused in language-server sessions.

        self.put_control_request(
            CreateNotebookCommand(
                execution_requests=tuple(
                    ExecuteCellCommand(cell_id=cell_id, code=code)
                    for cell_id, code in codes.items()
                ),
                set_ui_element_value_request=UpdateUIElementCommand(
                    object_ids=request.object_ids,
                    values=request.values,
                ),
                auto_run=request.auto_run,
                cell_ids=tuple(codes.keys()),
            ),
            from_consumer_id=None,
        )

    def close(self) -> None:
        """Close the session and its owned kernel resources."""
        if self._closed:
            return
        self._closed = True
        logger.info(f"Closing session {self.initialization_id}")
        self._kernel_manager.close_kernel()
        self._queue_manager.close_queues()
        self._operation_sink.detach()


class Sessions:
    """The language server's collection of live kernel sessions."""

    def __init__(self, server: LanguageServer) -> None:
        self._server = server
        self._sessions: dict[str, Session] = {}

    def __iter__(self) -> Iterator[Session]:
        """Iterate over the live sessions."""
        return iter(self._sessions.values())

    def get(self, notebook_uri: str) -> Session | None:
        """Return the live session for a notebook, if one exists."""
        return self._sessions.get(notebook_uri)

    def start(
        self,
        notebook_uri: str,
        executable: str,
        working_directory: str | None = None,
    ) -> Session:
        """Start or reuse the notebook's session.

        A different executable replaces the existing session only after the
        replacement has started successfully.
        """
        current = self.get(notebook_uri)
        if current is not None and current.executable == executable:
            current.attach()
            return current

        replacement = self._create(notebook_uri, executable, working_directory)
        self._sessions[notebook_uri] = replacement
        if current is not None:
            self._close(current, notebook_uri)
        return replacement

    def _create(
        self,
        notebook_uri: str,
        executable: str,
        working_directory: str | None = None,
    ) -> Session:
        ipc_queues, connection_info = IpcQueues.create()
        queue_manager = IpcQueueManager.from_ipc(ipc_queues)
        app_file_manager = LspAppFileManager(
            server=self._server,
            notebook_uri=notebook_uri,
        )
        config_manager = get_default_config_manager(current_path=app_file_manager.path)
        kernel_manager = LspKernelManager(
            executable=executable,
            queue_manager=queue_manager,
            app_file_manager=app_file_manager,
            config_manager=config_manager,
            connection_info=connection_info,
            working_directory=working_directory,
        )

        logger.info(f"Starting session for {notebook_uri}")
        return Session(
            initialization_id=str(uuid4()),
            notebook_uri=notebook_uri,
            operation_sink=_OperationSink(self._server, notebook_uri),
            queue_manager=queue_manager,
            kernel_manager=kernel_manager,
            app_file_manager=app_file_manager,
            config_manager=config_manager,
        )

    def attach(self, notebook_uri: str, workspace: Workspace) -> None:
        """Attach and synchronize an existing session."""
        session = self.get(notebook_uri)
        if session is None:
            return
        session.sync(workspace)
        session.attach()

    def sync(self, notebook_uri: str, workspace: Workspace) -> None:
        """Synchronize an existing session with its notebook document."""
        session = self.get(notebook_uri)
        if session is not None:
            session.sync(workspace)

    def detach(self, notebook_uri: str) -> None:
        """Detach an existing session without stopping its kernel."""
        session = self.get(notebook_uri)
        if session is not None:
            session.detach()

    def close(self, notebook_uri: str) -> None:
        """Close and forget a notebook's session."""
        session = self._sessions.pop(notebook_uri, None)
        if session is None:
            return

        self._close(session, notebook_uri)

    @staticmethod
    def _close(session: Session, notebook_uri: str) -> None:
        """Close a session without allowing cleanup failure to escape."""
        logger.info(f"Closing session for {notebook_uri}")
        try:
            session.close()
        except Exception:
            logger.exception(f"Error closing session for {notebook_uri}")

    def close_all(self) -> None:
        """Close all live sessions."""
        logger.info("Closing all sessions")
        for notebook_uri in list(self._sessions):
            self.close(notebook_uri)
