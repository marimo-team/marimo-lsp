# Copyright 2026 Marimo. All rights reserved.

"""Run marimo-lsp under Pyodide."""

from __future__ import annotations

import logging
import typing

import msgspec

from marimo_lsp.loggers import get_logger, lsp_handler
from marimo_lsp.server import create_server
from marimo_lsp.wasm.kernels import ProcessCallbacks, WasmKernels

if typing.TYPE_CHECKING:
    from collections.abc import Callable

    from pygls.lsp.server import LanguageServer


class _MessageWriter:
    """Adapt pygls writes to a host-provided JSON message callback."""

    def __init__(self, write_message: Callable[[str], None]) -> None:
        self._write_message = write_message

    def write(self, data: bytes) -> None:
        """Write one complete JSON-RPC message."""
        self._write_message(data.decode("utf-8"))

    def close(self) -> None:
        """Leave the host-owned output stream open."""


class WasmServer:
    """Drive pygls one JSON-RPC message at a time from JavaScript."""

    def __init__(
        self,
        write_message: Callable[[str], None],
        process_callbacks: ProcessCallbacks,
    ) -> None:
        self._kernels = WasmKernels(process_callbacks)
        self._server: LanguageServer = create_server(kernels=self._kernels)
        self._server.protocol.set_writer(
            _MessageWriter(write_message),
            include_headers=False,
        )
        logger = get_logger()
        logger.setLevel(logging.DEBUG)
        logger.addHandler(lsp_handler(self._server))

    def handle_message(self, message_json: str) -> None:
        """Deserialize and dispatch one complete JSON-RPC message."""
        message = self._server.protocol.structure_message(
            msgspec.json.decode(message_json)
        )
        self._server.protocol.handle_message(message)

    def close(self) -> None:
        """Release sessions and protocol resources."""
        self._server.shutdown()

    def handle_kernel_bytes(self, process_id: str, chunk: bytes) -> None:
        """Route opaque process bytes into their WASM kernel."""
        self._kernels.accept(process_id, bytes(chunk))

    def handle_kernel_exit(
        self,
        process_id: str,
        code: int | None,
        signal: str | None,
    ) -> None:
        """Route a native process exit into its WASM kernel."""
        self._kernels.exited(process_id, code, signal)


def create_bridge(
    write_message: Callable[[str], None],
    process_callbacks: ProcessCallbacks,
) -> WasmServer:
    """Create the message boundary exported to JavaScript."""
    return WasmServer(write_message, process_callbacks)
