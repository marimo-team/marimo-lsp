# Copyright 2026 Marimo. All rights reserved.

"""Run native kernels from the WASM language server."""

from __future__ import annotations

import asyncio
import json
import typing
from uuid import uuid4

from marimo._config.settings import GLOBAL_SETTINGS
from marimo._messaging.types import KernelMessage
from marimo._runtime.commands import AppMetadata

from marimo_lsp.kernels import KernelOpenError, normalize_marimo_version
from marimo_lsp.loggers import get_logger
from marimo_lsp.wasm.protocol import (
    Close,
    Control,
    Decoder,
    Error,
    FromBridge,
    Input,
    Interrupt,
    KernelLaunchArgs,
    LocateSessionCache,
    Log,
    Operation,
    Ready,
    SessionCacheLocation,
    Start,
    ToBridge,
    encode,
)

if typing.TYPE_CHECKING:
    from collections.abc import Callable

    from marimo._config.manager import MarimoConfigManager
    from marimo._runtime.commands import CommandMessage

    from marimo_lsp.app_file_manager import LspAppFileManager
    from marimo_lsp.kernels import Kernel


logger = get_logger()


class ProcessCallbacks(typing.Protocol):
    """Opaque native process support supplied by JavaScript."""

    def spawn(
        self,
        process_id: str,
        executable: str,
        working_directory: str,
    ) -> None:
        """Start a selected-Python kernel bridge."""
        ...

    def write(self, process_id: str, chunk: bytes) -> None:
        """Write opaque bytes to a kernel bridge."""
        ...

    def close(self, process_id: str) -> None:
        """Close a kernel bridge's input."""
        ...


class WasmKernel:
    """A native kernel reached through opaque process bytes."""

    def __init__(  # noqa: PLR0913
        self,
        *,
        callbacks: ProcessCallbacks,
        process_id: str,
        executable: str,
        working_directory: str,
        notebook_path: str | None,
        receive: Callable[[KernelMessage], None],
        on_close: Callable[[], None],
    ) -> None:
        self._callbacks = callbacks
        self._process_id = process_id
        self._receive = receive
        self._on_close = on_close
        self._decoder = Decoder(FromBridge)
        self._ready = asyncio.get_running_loop().create_future()
        self._locations: dict[str, asyncio.Future[str | None]] = {}
        self._notebook_path = notebook_path
        self._initial_session_cache_path: str | None = None
        self._can_locate_session_cache = False
        self._closed = False
        self.executable = executable
        self.working_directory = working_directory
        self.marimo_version: str | None = None

    def accept(self, chunk: bytes) -> None:
        """Decode operations received from the kernel bridge."""
        if self._closed:
            return
        for message in self._decoder.feed(chunk):
            if isinstance(message, Ready):
                self.marimo_version = normalize_marimo_version(message.marimo_version)
                # The path belongs to the native host. Pyodide's POSIX pathlib
                # cannot validate Windows paths, so keep it opaque here.
                self._initial_session_cache_path = message.session_cache_path
                self._can_locate_session_cache = message.can_locate_session_cache
                if not self._ready.done():
                    self._ready.set_result(None)
            elif isinstance(message, SessionCacheLocation):
                future = self._locations.get(message.request_id)
                if future is not None and not future.done():
                    future.set_result(message.path)
            elif isinstance(message, Operation):
                self._receive(KernelMessage(bytes(message.message)))
            elif isinstance(message, Error):
                self._fail(message.message)
            elif isinstance(message, Log):
                logger.info(message.message)

    def exited(
        self,
        code: int | None,
        signal: str | None,
        stderr: str | None,
    ) -> None:
        """Report an unexpected kernel bridge exit."""
        if not self._closed:
            message = (
                f"Kernel bridge exited unexpectedly (code={code}, signal={signal})"
            )
            if stderr:
                message = f"{message}\nBridge stderr:\n{stderr}"
            self._fail(
                message,
                close_process=False,
            )

    async def wait_ready(self) -> None:
        """Wait until the kernel bridge reports readiness."""
        await self._ready

    async def locate_saved_session(self, notebook_path: str) -> str | None:
        """Resolve a renamed notebook through the selected-Python bridge."""
        if self._closed:
            return None
        if notebook_path == self._notebook_path:
            return self._initial_session_cache_path
        if not self._can_locate_session_cache:
            return None
        request_id = str(uuid4())
        future: asyncio.Future[str | None] = asyncio.get_running_loop().create_future()
        self._locations[request_id] = future
        try:
            self._write(
                LocateSessionCache(
                    request_id=request_id,
                    notebook_path=notebook_path,
                )
            )
            return await future
        finally:
            self._locations.pop(request_id, None)

    def abort(self) -> None:
        """Release a kernel bridge that failed before readiness."""
        self._release(close_process=True)

    def _fail(self, error: str, *, close_process: bool = True) -> None:
        if not self._ready.done():
            self._ready.set_exception(KernelOpenError(error))
        else:
            self._receive(
                KernelMessage(
                    json.dumps({"op": "kernel-startup-error", "error": error}).encode()
                )
            )
        self._release(close_process=close_process)

    def _release(
        self,
        *,
        close_process: bool,
        request_close: bool = False,
    ) -> None:
        """Release the bridge exactly once, even when a close write fails."""
        if self._closed:
            return
        self._closed = True
        for future in self._locations.values():
            if not future.done():
                future.cancel()
        self._locations.clear()
        try:
            if request_close:
                self._write(Close())
        finally:
            try:
                if close_process:
                    self._callbacks.close(self._process_id)
            finally:
                self._on_close()

    def _write(self, message: ToBridge) -> None:
        self._callbacks.write(self._process_id, encode(message))

    def send(self, request: CommandMessage) -> None:
        """Send a command to the kernel."""
        self._write(Control(request=request))

    def input(self, text: str) -> None:
        """Send an input response to the kernel."""
        self._write(Input(text=text))

    def interrupt(self) -> None:
        """Interrupt the kernel."""
        self._write(Interrupt())

    def close(self) -> None:
        """Close the kernel bridge."""
        self._release(close_process=True, request_close=True)


class WasmKernels:
    """Launch native kernels for the WASM language server."""

    def __init__(self, callbacks: ProcessCallbacks) -> None:
        self._callbacks = callbacks
        self._kernels: dict[str, WasmKernel] = {}

    async def launch(
        self,
        *,
        executable: str,
        working_directory: str,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
        receive: Callable[[KernelMessage], None],
    ) -> Kernel:
        """Launch a kernel through JavaScript's native process support."""
        process_id = str(uuid4())

        def forget() -> None:
            self._kernels.pop(process_id, None)

        kernel = WasmKernel(
            callbacks=self._callbacks,
            process_id=process_id,
            executable=executable,
            working_directory=working_directory,
            notebook_path=app_file_manager.path,
            receive=receive,
            on_close=forget,
        )
        self._kernels[process_id] = kernel
        try:
            self._callbacks.spawn(process_id, executable, working_directory)
            self._callbacks.write(
                process_id,
                encode(
                    Start(
                        working_directory=working_directory,
                        kernel_args=KernelLaunchArgs(
                            configs=app_file_manager.app.cell_manager.config_map(),
                            app_metadata=AppMetadata(
                                query_params={},
                                filename=app_file_manager.path,
                                cli_args={},
                                argv=None,
                                app_config=app_file_manager.app.config,
                            ),
                            user_config=config_manager.get_config(hide_secrets=False),
                            log_level=GLOBAL_SETTINGS.LOG_LEVEL,
                            profile_path=None,
                        ),
                    )
                ),
            )
            await kernel.wait_ready()
        except BaseException:
            kernel.abort()
            raise
        return kernel

    def accept(self, process_id: str, chunk: bytes) -> None:
        """Deliver opaque stdout bytes to their WASM kernel."""
        kernel = self._kernels.get(process_id)
        if kernel is not None:
            kernel.accept(chunk)

    def exited(
        self,
        process_id: str,
        code: int | None,
        signal: str | None,
        stderr: str | None,
    ) -> None:
        """Report a kernel bridge exit to its WASM kernel."""
        kernel = self._kernels.get(process_id)
        if kernel is not None:
            kernel.exited(code, signal, stderr)

    def close_all(self) -> None:
        """Close every tracked kernel bridge."""
        for kernel in tuple(self._kernels.values()):
            try:
                kernel.close()
            except Exception:
                logger.exception("Error closing WASM kernel bridge")
        self._kernels.clear()
