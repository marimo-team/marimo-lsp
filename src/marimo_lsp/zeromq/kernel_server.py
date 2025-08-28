"""Standalone kernel server entry point for ZeroMQ-based IPC."""

from __future__ import annotations

import sys
from multiprocessing import connection

from marimo._runtime import runtime

from marimo_lsp.types import decode_kernel_args
from marimo_lsp.zeromq.queue_manager import ZeroMqQueueManager, decode_connection_info


def main() -> None:
    """Launch a marimo kernel using ZeroMQ for IPC.

    This function is the entry point for the kernel subprocess.
    It reads connection information from stdin and sets up ZeroMQ
    queues that proxy to marimo's internal kernel.
    """
    connection_info = decode_connection_info(sys.stdin.readline().strip())
    kernel_args = decode_kernel_args(sys.stdin.readline().strip())

    queue_manager = ZeroMqQueueManager.from_connection_info(connection_info)
    listener = connection.Listener(family="AF_INET")

    runtime.launch_kernel(
        # Queues
        set_ui_element_queue=queue_manager.set_ui_element_queue,
        interrupt_queue=queue_manager.win32_interrupt_queue,
        completion_queue=queue_manager.completion_queue,
        control_queue=queue_manager.control_queue,
        input_queue=queue_manager.input_queue,
        # Forwarded args from parent
        app_metadata=kernel_args.app_metadata,
        log_level=kernel_args.log_level,
        user_config=kernel_args.user_config,
        configs=kernel_args.configs,
        # Hardcoded
        socket_addr=listener.address,
        virtual_files_supported=False,
        redirect_console_to_browser=False,
        is_edit_mode=True,
        profile_path=None,
        stream_queue=None,
    )

    queue_manager.close_queues()


if __name__ == "__main__":
    main()
