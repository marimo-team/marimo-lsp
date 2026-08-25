# Copyright 2026 Marimo. All rights reserved.

"""Run kernels directly from native Python."""

from __future__ import annotations

import asyncio
import contextlib
import queue
import threading
import typing

from marimo._ipc import QueueManager as IpcQueues
from marimo._session.managers import IPCQueueManagerImpl as IpcQueueManager

from marimo_lsp.kernels.manager import Manager
from marimo_lsp.loggers import get_logger

if typing.TYPE_CHECKING:
    from collections.abc import Callable

    from marimo._config.manager import MarimoConfigManager
    from marimo._messaging.types import KernelMessage
    from marimo._runtime.commands import CommandMessage

    from marimo_lsp.app_file_manager import LspAppFileManager


logger = get_logger()


class NativeKernel:
    """Own a native marimo kernel and its direct IPC transport."""

    def __init__(
        self,
        queue_manager: IpcQueueManager,
        manager: Manager,
    ) -> None:
        self._queue_manager = queue_manager
        self._manager = manager
        self._closed = False
        self._listener_thread: threading.Thread | None = None
        self.executable = manager.executable
        self.working_directory = manager.working_directory
        self.marimo_version: str | None = None
        self.session_cache_path: str | None = None

    def start(self, receive: Callable[[KernelMessage], None]) -> None:
        """Start the kernel process and operation listener."""
        self._manager.start_kernel()
        self.marimo_version = self._manager.marimo_version
        self.session_cache_path = self._manager.session_cache_path

        def listen() -> None:
            stream_queue = self._queue_manager.stream_queue
            if stream_queue is None:
                return
            while not self._closed:
                try:
                    message = stream_queue.get(timeout=0.1)
                    if message is None:
                        return
                    receive(message)
                except queue.Empty:
                    continue

        self._listener_thread = threading.Thread(target=listen, daemon=True)
        self._listener_thread.start()

    def send(self, request: CommandMessage) -> None:
        """Send a command over marimo IPC."""
        self._queue_manager.put_control_request(request)

    def input(self, text: str) -> None:
        """Send an input response over marimo IPC."""
        self._queue_manager.put_input(text)

    def interrupt(self) -> None:
        """Interrupt the kernel process."""
        self._manager.interrupt_kernel()

    def close(self) -> None:
        """Close the kernel process and IPC queues."""
        if self._closed:
            return
        self._closed = True
        try:
            if self._manager.kernel_task is not None:
                self._manager.close_kernel()
        finally:
            self._queue_manager.close_queues()


class NativeKernels:
    """Launch kernels with native Python process and IPC support."""

    async def launch(
        self,
        *,
        executable: str,
        working_directory: str,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
        receive: Callable[[KernelMessage], None],
    ) -> NativeKernel:
        """Launch a native kernel and connect directly to its IPC queues."""
        ipc_queues, connection_info = IpcQueues.create()
        queue_manager = IpcQueueManager.from_ipc(ipc_queues)
        manager = Manager(
            executable=executable,
            queue_manager=queue_manager,
            app_file_manager=app_file_manager,
            config_manager=config_manager,
            connection_info=connection_info,
            working_directory=working_directory,
        )
        kernel = NativeKernel(queue_manager, manager)
        start_task = asyncio.create_task(asyncio.to_thread(kernel.start, receive))

        def close_after_cancelled_start(task: asyncio.Task[None]) -> None:
            with contextlib.suppress(BaseException):
                task.result()
            try:
                kernel.close()
            except Exception:
                logger.exception("Error closing kernel after cancelled launch")

        try:
            await asyncio.shield(start_task)
        except asyncio.CancelledError:
            # Cancelling `to_thread` cannot stop the worker. Close its kernel
            # once startup finishes instead of abandoning the process.
            start_task.add_done_callback(close_after_cancelled_start)
            raise
        except BaseException:
            try:
                kernel.close()
            except Exception:
                logger.exception("Error closing kernel after failed launch")
            raise
        return kernel
