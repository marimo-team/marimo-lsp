"""Marimo Language Server Protocol implementation."""

import logging

from marimo_lsp.loggers import get_logger, lsp_handler
from marimo_lsp.server import create_server


def main() -> None:
    """Run the marimo LSP server."""
    server = create_server()
    logger = get_logger()
    logger.setLevel(logging.DEBUG)
    logger.addHandler(lsp_handler(server))
    server.start_io()
