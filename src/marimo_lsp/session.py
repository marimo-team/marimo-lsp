"""Minimal LSP session implementation for marimo."""

from __future__ import annotations

import queue
import threading
from typing import TYPE_CHECKING

from marimo._runtime.commands import (
    CommandMessage,
    CreateNotebookCommand,
    ExecuteCellCommand,
    HTTPRequest,
    UpdateUIElementCommand,
)
from marimo._session.state.session_view import SessionView

from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
    from marimo._config.manager import MarimoConfigManager
    from marimo._ipc import QueueManager
    from marimo._server.models.models import InstantiateNotebookRequest
    from marimo._types.ids import ConsumerId

    from marimo_lsp.app_file_manager import LspAppFileManager
    from marimo_lsp.kernel_manager import LspKernelManager
    from marimo_lsp.session_consumer import LspSessionConsumer


logger = get_logger()


class LspSession:
    """Minimal session for LSP integration."""

    def __init__(  # noqa: PLR0913
        self,
        *,
        initialization_id: str,
        session_consumer: LspSessionConsumer,
        queue_manager: QueueManager,
        kernel_manager: LspKernelManager,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
    ) -> None:
        self.initialization_id = initialization_id
        self.app_file_manager = app_file_manager
        self.config_manager = config_manager
        # used by HTML exporter and others
        self.session_view = SessionView()

        self._consumer = session_consumer
        self._queue_manager = queue_manager
        self._kernel_manager = kernel_manager
        self._closed = False
        self._listener_thread: threading.Thread | None = None

        # Start kernel and message listener
        self._kernel_manager.start_kernel()
        self._start_message_listener()
        logger.info(f"Started session {initialization_id}")

    @property
    def kernel_manager(self) -> LspKernelManager:
        """Get the kernel manager."""
        return self._kernel_manager

    def _start_message_listener(self) -> None:
        """Start background thread to forward kernel messages to consumer."""

        def listen() -> None:
            stream_queue = self._queue_manager.stream_queue
            if stream_queue is None:
                return
            while not self._closed:
                try:
                    msg = stream_queue.get(timeout=0.1)
                    self._consumer.notify(msg)
                except queue.Empty:  # noqa: PERF203
                    continue

        self._listener_thread = threading.Thread(target=listen, daemon=True)
        self._listener_thread.start()

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
        self._queue_manager.control_queue.put(request)

    def instantiate(
        self,
        request: InstantiateNotebookRequest,
        *,
        http_request: HTTPRequest | None,
    ) -> None:
        """Instantiate the notebook."""
        codes = request.codes or self.app_file_manager.app.cell_manager.code_map()

        del http_request  # Unused in LSP session

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
            ),
            from_consumer_id=None,
        )

    def close(self) -> None:
        """Close the session."""
        if self._closed:
            return
        self._closed = True
        logger.info(f"Closing session {self.initialization_id}")
        self._kernel_manager.close_kernel()
        self._queue_manager.close_queues()
        self._consumer.on_detach()
