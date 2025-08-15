"""Minimal LSP session consumer for marimo."""

from __future__ import annotations

from typing import TYPE_CHECKING

from marimo._messaging.ops import MessageOperation, serialize
from marimo._server.model import ConnectionState, SessionConsumer
from marimo._types.ids import ConsumerId

from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
    from collections.abc import Callable

    from marimo._messaging.types import KernelMessage
    from pygls.lsp.server import LanguageServer


logger = get_logger()


class LspSessionConsumer(SessionConsumer):
    """Session consumer that forwards kernel messages over LSP.

    It implements the SessionConsumer interface that marimo expects, but
    instead of managing WebSocket connections, it forwards messages via LSP.
    """

    def __init__(self, server: LanguageServer, notebook_uri: str) -> None:
        """Initialize the consumer."""
        self.server = server
        self.notebook_uri = notebook_uri
        self._is_connected = True
        super().__init__(consumer_id=ConsumerId(notebook_uri))
        logger.debug(f"Created LSP consumer for {notebook_uri}")

    def on_start(self) -> Callable[[KernelMessage], None]:
        """Return a callback that receives kernel messages."""

        def handle_message(msg: KernelMessage) -> None:
            """Forward kernel message over LSP."""
            try:
                op_name, data = msg

                self.server.protocol.notify(
                    "marimo/operation",
                    {"notebookUri": self.notebook_uri, "op": op_name, "data": data},
                )

                logger.debug(f"Forwarded {op_name} to {self.notebook_uri}")

            except Exception:
                logger.exception("Error forwarding kernel message")

        return handle_message

    def write_operation(self, op: MessageOperation) -> None:
        """Write an operation to VS Code.

        This is called by the Session for operations that don't come from
        the kernel message queue (e.g., initial state, UI updates).
        """
        self.server.protocol.notify(
            "marimo/operation",
            {
                "notebookUri": self.notebook_uri,
                "op": op.name,
                "data": serialize(op),
            },
        )
        logger.debug(f"Sent {op.name} operation to {self.notebook_uri}")

    def connection_state(self) -> ConnectionState:
        """Report our connection state."""
        return ConnectionState.OPEN if self._is_connected else ConnectionState.CLOSED

    def on_stop(self) -> None:
        """Clean up when stopping."""
        self._is_connected = False
        logger.info(f"Stopped LSP consumer for {self.notebook_uri}")
