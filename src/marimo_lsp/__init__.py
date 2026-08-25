# Copyright 2026 Marimo. All rights reserved.

"""Marimo Language Server Protocol implementation."""

import logging

from marimo_lsp.loggers import get_logger, lsp_handler
from marimo_lsp.server import create_server


def main() -> None:
    """Run the marimo LSP server."""
    # Keep native runtime imports out of the importable package so the WASM
    # entrypoint can provide its own kernel adapter.
    from marimo_lsp.kernels.native import NativeKernels  # noqa: PLC0415
    from marimo_lsp.saved_session_store import (  # noqa: PLC0415
        LocalSavedSessionFiles,
    )

    server = create_server(
        kernels=NativeKernels(),
        saved_session_files=LocalSavedSessionFiles(),
    )
    logger = get_logger()
    logger.setLevel(logging.DEBUG)
    logger.addHandler(lsp_handler(server))
    server.start_io()
