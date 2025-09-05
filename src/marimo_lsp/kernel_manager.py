"""Kernel manager for marimo-lsp."""

from __future__ import annotations

import subprocess
import typing

from marimo._config.settings import GLOBAL_SETTINGS
from marimo._runtime.requests import AppMetadata
from marimo._server.model import SessionMode
from marimo._server.sessions import KernelManager

from marimo_lsp.types import KernelArgs, encode_kernel_args
from marimo_lsp.zeromq.queue_manager import encode_connection_info

if typing.TYPE_CHECKING:
    from marimo._config.manager import MarimoConfigManager

    from marimo_lsp.app_file_manager import LspAppFileManager
    from marimo_lsp.zeromq.queue_manager import ConnectionInfo, ZeroMqQueueManager


@dataclasses.dataclass
class PopenProcessLike(ProcessLike):
    """Wraps `subprocess.Popen` as a `ProcessLike`.

    Provides the `ProcessLike` protocol required by marimo's KernelManager.
    """

    inner: subprocess.Popen

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


def launch_kernel_subprocess(
    executable: str,
    connection_info: ConnectionInfo,
    configs: dict,
    app_metadata: AppMetadata,
    config_manager: MarimoConfigManager,
) -> subprocess.Popen:
    """Launch kernel as a subprocess with ZeroMQ IPC."""
    kernel_args = KernelArgs(
        configs=configs,
        app_metadata=app_metadata,
        user_config=config_manager.get_config(hide_secrets=False),
        log_level=GLOBAL_SETTINGS.LOG_LEVEL,
    )

    process = subprocess.Popen(
    process = subprocess.Popen(  # noqa: S603
        [
            executable,
            "-m",
            "marimo_lsp.zeromq.kernel_server",
        ],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )

    assert process.stdin, "Expected stdin"
    process.stdin.write(encode_connection_info(connection_info) + "\n")
    process.stdin.write(encode_kernel_args(kernel_args) + "\n")
    process.stdin.flush()
    process.stdin.close()

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
            mode=SessionMode.EDIT,
            queue_manager=queue_manager,
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
        self.kernel_process = None
        self.executable = executable
        self.connection_info = connection_info

    def start_kernel(self) -> None:
        """Start an instance of the marimo kernel using ZeroMQ IPC."""
        self.kernel_task = PopenProcessLike(
            launch_kernel_subprocess(
                executable=self.executable,
                connection_info=self.connection_info,
                configs=self.configs,
                app_metadata=self.app_metadata,
                config_manager=self.config_manager,
            )
        )

        # Store process handle (compatible with mp.Process interface)
        self.kernel_task = self.kernel_process
