"""Kernel manager for marimo-lsp."""

from __future__ import annotations

import typing

from marimo._config.settings import GLOBAL_SETTINGS
from marimo._messaging.types import KernelMessage
from marimo._runtime.requests import AppMetadata
from marimo._server.model import SessionMode
from marimo._server.sessions import KernelManager
from marimo._utils.typed_connection import TypedConnection

if typing.TYPE_CHECKING:
    from marimo._config.manager import MarimoConfigManager
    from marimo._server.sessions import QueueManager

    from marimo_lsp.app_file_manager import LspAppFileManager


def launch_kernel(*args) -> None:  # noqa: ANN002
    """Launch the marimo kernel with the correct Python environment.

    Runs inside a `multiprocessing.Process` spawned with `ctx.set_executable()`.

    However, multiprocessing reconstructs the parent's `sys.path`, overriding the
    venv's paths. We fix this by querying sys.executable (which IS correctly set)
    for its natural `sys.path` and replacing ours before importing marimo.
    """
    import json  # noqa: PLC0415
    import subprocess  # noqa: PLC0415
    import sys  # noqa: PLC0415

    # Get the natural sys.path from the venv's Python interpreter
    # sys.executable is correctly set to the venv's Python thanks to set_executable()
    result = subprocess.run(  # noqa: S603
        [sys.executable, "-c", "import sys, json; print(json.dumps(sys.path))"],
        capture_output=True,
        text=True,
        check=True,
    )

    # Replace the inherited (wrong) sys.path with the venv's natural paths
    sys.path = json.loads(result.stdout)

    # Now we can import marimo from the correct environment
    from marimo._runtime import runtime  # noqa: PLC0415

    runtime.launch_kernel(*args)


class LspKernelManager(KernelManager):
    """Kernel manager for marimo-lsp."""

    def __init__(
        self,
        *,
        executable: str,
        queue_manager: QueueManager,
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
        self.executable = executable

    def start_kernel(self) -> None:
        """Start an instance of the marimo kernel."""
        import multiprocessing as mp  # noqa: PLC0415
        from multiprocessing import connection  # noqa: PLC0415

        # We use a process in edit mode so that we can interrupt the app
        # with a SIGINT; we don't mind the additional memory consumption,
        # since there's only one client sess
        is_edit_mode = self.mode == SessionMode.EDIT

        # Need to use a socket for windows compatibility
        listener = connection.Listener(family="AF_INET")

        ctx = mp.get_context("spawn")
        ctx.set_executable(self.executable)

        kernel_task = ctx.Process(
            target=launch_kernel,
            args=(
                self.queue_manager.control_queue,
                self.queue_manager.set_ui_element_queue,
                self.queue_manager.completion_queue,
                self.queue_manager.input_queue,
                # stream queue unused
                None,
                listener.address,
                is_edit_mode,
                self.configs,
                self.app_metadata,
                self.config_manager.get_config(hide_secrets=False),
                self._virtual_files_supported,
                self.redirect_console_to_browser,
                self.queue_manager.win32_interrupt_queue,
                self.profile_path,
                GLOBAL_SETTINGS.LOG_LEVEL,
            ),
            # The process can't be a daemon, because daemonic processes
            # can't create children
            # https://docs.python.org/3/library/multiprocessing.html#multiprocessing.Process.daemon  # noqa: E501
            daemon=False,
        )

        kernel_task.start()

        self.kernel_task = kernel_task
        # First thing kernel does is connect to the socket, so it's safe to call accept
        self._read_conn = TypedConnection[KernelMessage].of(listener.accept())
