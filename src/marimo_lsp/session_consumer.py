"""Minimal LSP session consumer for marimo."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING

from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
    from marimo._messaging.types import KernelMessage
    from pygls.lsp.server import LanguageServer


logger = get_logger()


class LspSessionConsumer:
    """Forwards kernel messages to VS Code over LSP."""

    def __init__(self, server: LanguageServer, notebook_uri: str) -> None:
        self.server = server
        self.notebook_uri = notebook_uri
        self._is_connected = True

    def notify(self, message: KernelMessage) -> None:
        """Forward kernel message to VS Code."""
        try:
            operation = json.loads(message)
            self.server.protocol.notify(
                "marimo/operation",
                {"notebookUri": self.notebook_uri, "operation": operation},
            )
            logger.debug(
                f"Forwarded {operation.get('op', 'unknown')} to {self.notebook_uri}"
            )
        except Exception:
            logger.exception("Error forwarding kernel message")

    def on_detach(self) -> None:
        """Mark as disconnected."""
        self._is_connected = False
        logger.info(f"Detached consumer for {self.notebook_uri}")
