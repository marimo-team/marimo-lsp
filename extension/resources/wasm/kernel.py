# Copyright 2026 Marimo. All rights reserved.

"""Run a marimo kernel behind the WASM language server's stdio protocol.

This script runs in the notebook's selected Python. It adapts Node's opaque
stdin and stdout bytes to marimo's normal edit-mode kernel manager.
"""

from __future__ import annotations

import atexit
import contextlib
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING

import msgspec
from marimo._config.manager import MarimoConfigReader
from marimo._session.managers.kernel import KernelManagerImpl
from marimo._session.managers.queue import QueueManagerImpl
from marimo._session.model import SessionMode
from protocol import (
    HEADER_SIZE,
    MAX_FRAME_SIZE,
    Close,
    Control,
    Error,
    FromBridge,
    Input,
    Interrupt,
    Operation,
    Ready,
    Start,
    ToBridge,
    encode,
    read_header,
)

if TYPE_CHECKING:
    from marimo._config.config import MarimoConfig
    from marimo._messaging.types import KernelMessage

_write_lock = threading.Lock()
_decoder = msgspec.json.Decoder(ToBridge)


class _StaticConfigManager(MarimoConfigReader):
    """Expose the launch-time user config through marimo's manager API."""

    def __init__(self, config: MarimoConfig) -> None:
        self._user_config = config

    def get_config(self, *, hide_secrets: bool = True) -> MarimoConfig:
        del hide_secrets
        return self._user_config


def _read_frame() -> ToBridge | None:
    header = sys.stdin.buffer.read(HEADER_SIZE)
    if not header:
        return None
    length = read_header(header)
    if length > MAX_FRAME_SIZE:
        msg = f"Kernel frame exceeds {MAX_FRAME_SIZE} bytes"
        raise ValueError(msg)
    payload = sys.stdin.buffer.read(length)
    if len(payload) != length:
        message = "Incomplete kernel frame payload"
        raise EOFError(message)
    return _decoder.decode(payload)


def _write_frame(message: FromBridge) -> None:
    frame = encode(message)
    with _write_lock:
        sys.stdout.buffer.write(frame)
        sys.stdout.buffer.flush()


class _Bridge:
    """Own marimo's edit-mode kernel manager and its stdio adapter."""

    def __init__(self) -> None:
        self._queues: QueueManagerImpl | None = None
        self._manager: KernelManagerImpl | None = None
        self._operation_thread: threading.Thread | None = None
        self._closed = False

    def start(self, message: Start) -> None:
        """Start a regular marimo edit-mode kernel subprocess."""
        working_directory = message.working_directory
        path = Path(working_directory)
        if not path.is_absolute() or not path.is_dir():
            msg = f"Invalid kernel working directory: {working_directory}"
            raise ValueError(msg)

        args = message.kernel_args
        self._queues = QueueManagerImpl(use_multiprocessing=True)
        self._manager = KernelManagerImpl(
            queue_manager=self._queues,
            mode=SessionMode.EDIT,
            configs=args.configs,
            app_metadata=args.app_metadata,
            config_manager=_StaticConfigManager(args.user_config),
            virtual_file_storage=None,
            redirect_console_to_browser=args.redirect_console_to_browser,
        )
        self._manager.start_kernel()
        self._operation_thread = threading.Thread(
            target=self._forward_operations,
            name="kernel-operation-forwarder",
            daemon=True,
        )
        self._operation_thread.start()
        _write_frame(Ready())

    def _forward_operations(self) -> None:
        assert self._manager is not None
        connection = self._manager.kernel_connection
        try:
            while True:
                message: KernelMessage = connection.recv()
                _write_frame(Operation(message=msgspec.Raw(message)))
        except (EOFError, OSError):
            if not self._closed:
                _write_frame(Error(message="Kernel connection closed unexpectedly"))

    def handle(self, message: ToBridge) -> bool:
        """Apply one command and return whether to keep reading."""
        if isinstance(message, Control):
            assert self._queues is not None
            self._queues.put_control_request(message.request)
        elif isinstance(message, Input):
            assert self._queues is not None
            self._queues.put_input(message.text)
        elif isinstance(message, Interrupt):
            self.interrupt()
        elif isinstance(message, Close):
            self.close()
            return False
        else:
            msg = f"Unexpected start message after kernel launch: {message!r}"
            raise TypeError(msg)
        return True

    def interrupt(self) -> None:
        """Interrupt the kernel subprocess."""
        if self._closed or self._manager is None:
            return
        self._manager.interrupt_kernel()

    def close(self) -> None:
        """Stop the kernel exactly once."""
        if self._closed:
            return
        self._closed = True
        if self._manager is not None:
            with contextlib.suppress(Exception):
                self._manager.close_kernel()
        if self._operation_thread is not None:
            self._operation_thread.join(timeout=1)


def _read_start_frame() -> Start:
    start = _read_frame()
    if not isinstance(start, Start):
        msg = "Expected start frame"
        raise TypeError(msg)
    return start


def main() -> None:
    """Serve kernel requests until the language server closes stdin."""
    bridge = _Bridge()
    atexit.register(bridge.close)
    try:
        bridge.start(_read_start_frame())
        while True:
            message = _read_frame()
            if message is None or not bridge.handle(message):
                break
    except Exception as error:
        _write_frame(Error(message=str(error)))
        raise
    finally:
        bridge.close()


if __name__ == "__main__":
    main()
