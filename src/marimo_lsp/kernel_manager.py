"""Kernel manager for marimo-lsp."""

from __future__ import annotations

import subprocess
import typing
from typing import TypeVar

import marimo._ipc as ipc
from marimo._config.settings import GLOBAL_SETTINGS
from marimo._runtime.requests import AppMetadata
from marimo._server.model import SessionMode
from marimo._server.sessions import KernelManager
from marimo._server.types import ProcessLike

from marimo_lsp.loggers import get_logger

if typing.TYPE_CHECKING:
    from marimo._config.manager import MarimoConfigManager
    from marimo._ipc.types import ConnectionInfo
    from marimo._server.sessions import QueueManager

    from marimo_lsp.app_file_manager import LspAppFileManager


logger = get_logger()


def launch_kernel(
    executable: str,
    args: ipc.KernelArgs,
) -> PopenProcessLike:
    """Launch kernel as a subprocess."""
    cmd = [executable, "-m", "marimo._ipc.launch_kernel"]
    logger.info(f"Launching kernel subprocess: {' '.join(cmd)}")
    logger.debug(f"Connection info: {args.connection_info}")

    process = subprocess.Popen(  # noqa: S603
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    assert process.stdin, "Expect subprocess stdin pipe"
    assert process.stdout, "Expect subprocess stdout pipe"
    assert process.stderr, "Expect subprocess stderr pipe"

    # Send over stdin
    process.stdin.write(args.encode_json())
    process.stdin.flush()
    process.stdin.close()

    logger.debug("Waiting for KERNEL_READY signal from kernel subprocess")

    # Wait for "KERNEL_READY" message
    ready_line = process.stdout.readline().decode("utf-8").strip()
    if ready_line != "KERNEL_READY":
        exit_code = process.poll()
        stderr = process.stderr.read().decode("utf-8", errors="replace")

        if exit_code is not None and exit_code != 0:
            msg = f"Kernel failed to start (exit code {exit_code}): {stderr}"
            logger.exception(msg)
            raise RuntimeError(msg)

        msg = (
            f"Invalid kernel response. Expected 'KERNEL_READY', got: '{ready_line}'. "
            f"Stderr: {stderr}"
        )
        logger.exception(msg)
        process.terminate()
        raise RuntimeError(msg)

    logger.info(f"Kernel subprocess started successfully with PID: {process.pid}")
    return PopenProcessLike(inner=process)


class LspKernelManager(KernelManager):
    """Kernel manager for marimo-lsp."""

    def __init__(
        self,
        *,
        executable: str,
        queue_manager: ipc.QueueManager,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
        connection_info: ConnectionInfo,
    ) -> None:
        super().__init__(
            # NB: Leaky abstraction. Mode affects internal behavior of
            # `KernelManager` based on whether `stream_queue` or
            # `socket_addr` is used.
            #
            # We use RUN even though VS Code is conceptually more like EDIT.
            # In EDIT mode, the kernel creates a `multiprocessing.Connection`,
            # which we'd need to proxy. RUN mode uses existing `stream_queue`
            # for message distribution which aligns with our ZeroMQ
            # architecture.
            mode=SessionMode.RUN,
            config_manager=config_manager,
            configs=app_file_manager.app.cell_manager.config_map(),
            queue_manager=typing.cast("QueueManager", queue_manager),
            app_metadata=AppMetadata(
                query_params={},
                filename=app_file_manager.path,
                cli_args={},
                argv=None,
                app_config=app_file_manager.app.config,
            ),
            redirect_console_to_browser=True,
            virtual_files_supported=False,
        )
        self.executable = executable
        self.connection_info = connection_info

    def start_kernel(self) -> None:
        """Start an instance of the marimo kernel using ZeroMQ IPC."""
        self.kernel_task = launch_kernel(
            executable=self.executable,
            args=ipc.KernelArgs(
                connection_info=self.connection_info,
                configs=self.configs,
                app_metadata=self.app_metadata,
                user_config=self.config_manager.get_config(hide_secrets=False),
                log_level=GLOBAL_SETTINGS.LOG_LEVEL,
                profile_path=self.profile_path,
            ),
        )


T = TypeVar("T")


class PopenProcessLike(ProcessLike):
    """Wraps `subprocess.Popen` as a `ProcessLike`.

    Provides the `ProcessLike` protocol required by marimo's KernelManager.
    """

    def __init__(self, inner: subprocess.Popen) -> None:
        """Initialize with a subprocess.Popen instance."""
        self.inner = inner

    @property
    def pid(self) -> int | None:
        """Get the process ID."""
        return self.inner.pid

    def is_alive(self) -> bool:
        """Check if the process is still running."""
        return self.inner.poll() is None

    def terminate(self) -> None:
        """Terminate the process."""
        self.inner.terminate()
