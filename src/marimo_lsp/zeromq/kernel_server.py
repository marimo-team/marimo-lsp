"""Standalone kernel server entry point for ZeroMQ-based IPC."""

from __future__ import annotations

import sys

from marimo._runtime import runtime

from marimo_lsp.types import LaunchKernelArgs
from marimo_lsp.zeromq.queue_manager import ConnectionInfo, ZeroMqQueueManager


def main() -> None:
    """Launch a marimo kernel using ZeroMQ for IPC.

    This function is the entry point for the kernel subprocess.
    It reads connection information from stdin and sets up ZeroMQ
    queues that proxy to marimo's internal kernel.
    """
    info = ConnectionInfo.decode_json(sys.stdin.readline().strip())
    args = LaunchKernelArgs.decode_json(sys.stdin.readline().strip())

    queue_manager = ZeroMqQueueManager.connect(info)
    runtime.launch_kernel(
        # Queues
        set_ui_element_queue=queue_manager.set_ui_element_queue,
        interrupt_queue=queue_manager.win32_interrupt_queue,
        completion_queue=queue_manager.completion_queue,
        control_queue=queue_manager.control_queue,
        input_queue=queue_manager.input_queue,
        stream_queue=queue_manager.stream_queue,
        # Forwarded args from parent
        app_metadata=args.app_metadata,
        log_level=args.log_level,
        user_config=args.user_config,
        configs=args.configs,
        profile_path=args.profile_path,
        # Hardcoded
        socket_addr=None,  # not needed because we have `stream_queue`
        is_edit_mode=True,  # always edit mode
        virtual_files_supported=False,
        redirect_console_to_browser=False,
    )


if __name__ == "__main__":
    main()
