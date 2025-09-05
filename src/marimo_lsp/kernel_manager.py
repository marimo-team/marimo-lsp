"""Kernel manager for marimo-lsp."""

from __future__ import annotations

import subprocess
import typing

from marimo._config.settings import GLOBAL_SETTINGS
from marimo._runtime.requests import AppMetadata
from marimo._server.model import SessionMode
from marimo._server.sessions import KernelManager

from marimo_lsp.loggers import get_logger
from marimo_lsp.types import LaunchKernelArgs
from marimo_lsp.zeromq.adapters import PopenProcessLike

logger = get_logger()

if typing.TYPE_CHECKING:
    from marimo._config.manager import MarimoConfigManager
    from marimo._server.sessions import QueueManager

    from marimo_lsp.app_file_manager import LspAppFileManager
    from marimo_lsp.zeromq.queue_manager import ConnectionInfo, ZeroMqQueueManager


def launch_kernel_subprocess(
    executable: str,
    connection_info: ConnectionInfo,
    kernel_args: LaunchKernelArgs,
) -> subprocess.Popen[bytes]:
    """Launch kernel as a subprocess with ZeroMQ IPC."""
    import threading
    
    cmd = [executable, "-m", "marimo_lsp.zeromq.kernel_server"]
    logger.info(f"Launching kernel subprocess: {' '.join(cmd)}")
    logger.debug(f"Connection info: {connection_info}")

    process = subprocess.Popen(  # noqa: S603
        cmd,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    def log_stderr():
        """Log stderr output from kernel subprocess."""
        if process.stderr:
            for line in process.stderr:
                logger.error(f"[Kernel stderr PID={process.pid}] {line.decode().rstrip()}")
    
    # Start thread to capture stderr
    stderr_thread = threading.Thread(target=log_stderr, daemon=True)
    stderr_thread.start()

    assert process.stdin, "Expected stdin"
    process.stdin.write(connection_info.encode_json() + b"\n")
    process.stdin.write(kernel_args.encode_json() + b"\n")
    process.stdin.flush()
    process.stdin.close()
    logger.info(f"Kernel subprocess started with PID: {process.pid}")
    return process


class LspKernelManager(KernelManager):
    """Kernel manager for marimo-lsp."""

    def __init__(
        self,
        *,
        executable: str,
        connection_info: ConnectionInfo,
        queue_manager: ZeroMqQueueManager,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
    ) -> None:
        super().__init__(
            # TODO: explain why run mode
            mode=SessionMode.RUN,
            queue_manager=typing.cast("QueueManager", queue_manager),
            config_manager=config_manager,
            configs=app_file_manager.app.cell_manager.config_map(),
            app_metadata=AppMetadata(
                query_params={},
                filename=app_file_manager.path,
                cli_args={},
                argv=None,
                app_config=app_file_manager.app.config,
            ),
            redirect_console_to_browser=False,
            virtual_files_supported=False,
        )
        self.executable = executable
        self.connection_info = connection_info

    def start_kernel(self) -> None:
        """Start an instance of the marimo kernel using ZeroMQ IPC."""
        self.kernel_task = PopenProcessLike(
            launch_kernel_subprocess(
                executable=self.executable,
                connection_info=self.connection_info,
                kernel_args=LaunchKernelArgs(
                    configs=self.configs,
                    app_metadata=self.app_metadata,
                    user_config=self.config_manager.get_config(hide_secrets=False),
                    log_level=GLOBAL_SETTINGS.LOG_LEVEL,
                    profile_path=self.profile_path,
                ),
            )
        )
