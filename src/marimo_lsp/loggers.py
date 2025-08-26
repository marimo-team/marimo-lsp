"""Logging utilities for marimo LSP."""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING

import lsprotocol.types as lsp

if TYPE_CHECKING:
    from pygls.lsp.server import LanguageServer


class LspLoggingHandler(logging.Handler):
    """Custom logging handler that sends messages through LSP window/logMessage."""

    def __init__(self, server: LanguageServer) -> None:
        super().__init__()
        self.server = server
        self.level_map = {
            logging.DEBUG: lsp.MessageType.Log,
            logging.INFO: lsp.MessageType.Info,
            logging.WARNING: lsp.MessageType.Warning,
            logging.ERROR: lsp.MessageType.Error,
            logging.CRITICAL: lsp.MessageType.Error,
        }

    def emit(self, record: logging.LogRecord) -> None:
        """Emit a log record through LSP window/logMessage."""
        if self.server.protocol.writer is None:
            return
        self.server.window_log_message(
            lsp.LogMessageParams(
                type=self.level_map.get(record.levelno, lsp.MessageType.Log),
                message=self.format(record),
            )
        )


def lsp_handler(server: LanguageServer) -> LspLoggingHandler:
    """Forward logs over LSP window/logMessage."""
    handler = LspLoggingHandler(server)
    handler.setFormatter(logging.Formatter("[%(name)s] %(message)s"))
    return handler


def get_logger() -> logging.Logger:
    """Get the marimo-lsp logger."""
    return logging.getLogger("marimo-lsp")


get_logger().setLevel(logging.DEBUG)
