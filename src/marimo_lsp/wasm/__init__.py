# Copyright 2026 Marimo. All rights reserved.

"""Run marimo-lsp under Pyodide."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import typing

import msgspec

from marimo_lsp.loggers import get_logger, lsp_handler
from marimo_lsp.saved_session_store import (
    CallbackSavedSessionFiles,
    SavedSessionFileCallbacks,
)
from marimo_lsp.server import create_server
from marimo_lsp.wasm.kernels import ProcessCallbacks, WasmKernels

if typing.TYPE_CHECKING:
    from collections.abc import Callable

    from pygls.lsp.server import LanguageServer

    from marimo_lsp.loggers import LspLoggingHandler


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
        saved_session_callbacks: SavedSessionFileCallbacks | None = None,
    ) -> None:
        self._kernels = WasmKernels(process_callbacks)
        files = (
            CallbackSavedSessionFiles(saved_session_callbacks)
            if saved_session_callbacks is not None
            else None
        )
        self._server: LanguageServer = create_server(
            kernels=self._kernels,
            saved_session_files=files,
        )
        self._server.protocol.set_writer(
            _MessageWriter(write_message),
            include_headers=False,
        )
        logger = get_logger()
        logger.setLevel(logging.DEBUG)
        self._log_handler: LspLoggingHandler = lsp_handler(self._server)
        logger.addHandler(self._log_handler)
        self._closed = False

    async def handle_message(self, message_json: str) -> None:
        """Deserialize, dispatch, and drive one JSON-RPC message to completion."""
        message = self._server.protocol.structure_message(
            msgspec.json.decode(message_json)
        )
        self._server.protocol.handle_message(message)

        # pygls schedules coroutine handlers on the current event loop. Its
        # regular transports own that loop, but this bridge is called directly
        # from JavaScript, so keep the loop alive until a request completes.
        message_id = getattr(message, "id", None)
        pending = self._server.protocol._request_futures.get(message_id)  # noqa: SLF001
        if pending is None:
            # Give coroutine notification handlers an opportunity to run.
            await asyncio.sleep(0)
            return

        with contextlib.suppress(BaseException):
            if isinstance(pending, asyncio.Future):
                await asyncio.shield(pending)
            else:
                await asyncio.wrap_future(pending)

    def close(self) -> None:
        """Release sessions and protocol resources."""
        if self._closed:
            return
        self._closed = True
        try:
            self._kernels.close_all()
            self._server.shutdown()
        finally:
            get_logger().removeHandler(self._log_handler)

    def handle_kernel_bytes(self, process_id: str, chunk: bytes) -> None:
        """Route opaque process bytes into their WASM kernel."""
        self._kernels.accept(process_id, bytes(chunk))

    def handle_kernel_exit(
        self,
        process_id: str,
        code: int | None,
        signal: str | None,
        stderr: str | None,
    ) -> None:
        """Route a native process exit into its WASM kernel."""
        self._kernels.exited(process_id, code, signal, stderr)


def create_bridge(
    write_message: Callable[[str], None],
    process_callbacks: ProcessCallbacks,
    saved_session_callbacks: SavedSessionFileCallbacks | None = None,
) -> WasmServer:
    """Create the message boundary exported to JavaScript."""
    return WasmServer(
        write_message,
        process_callbacks,
        saved_session_callbacks,
    )
