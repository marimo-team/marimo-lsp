# Copyright 2026 Marimo. All rights reserved.

"""Run a marimo kernel behind the WASM language server's stdio protocol.

This script runs in the notebook's selected Python. It owns marimo IPC and
ZeroMQ; Node only brokers its opaque stdin and stdout bytes.
"""

from __future__ import annotations

import atexit
import contextlib
import os
import signal
import subprocess
import sys
import threading
from pathlib import Path
from typing import TYPE_CHECKING

import marimo._ipc as ipc
import msgspec
from marimo._runtime.commands import StopKernelCommand
from marimo._session.managers import IPCQueueManagerImpl
from protocol import (
    HEADER_SIZE,
    Close,
    Control,
    Error,
    FromBridge,
    Input,
    Interrupt,
    Log,
    Operation,
    Ready,
    Start,
    ToBridge,
    encode,
    read_header,
)

if TYPE_CHECKING:
    from marimo._messaging.types import KernelMessage

_write_lock = threading.Lock()
_decoder = msgspec.json.Decoder(ToBridge)


def _read_frame() -> ToBridge | None:
    header = sys.stdin.buffer.read(HEADER_SIZE)
    if not header:
        return None
    length = read_header(header)
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
    """Own one native kernel and its marimo IPC queues."""

    def __init__(self) -> None:
        self._queues: IPCQueueManagerImpl | None = None
        self._ipc_queues: ipc.QueueManager | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._closed = False

    def start(self, message: Start) -> None:
        """Create queues and start the kernel subprocess."""
        working_directory = message.working_directory
        path = Path(working_directory)
        if not path.is_absolute() or not path.is_dir():
            msg = f"Invalid kernel working directory: {working_directory}"
            raise ValueError(msg)

        ipc_queues, connection_info = ipc.QueueManager.create()
        self._ipc_queues = ipc_queues
        self._queues = IPCQueueManagerImpl.from_ipc(ipc_queues)

        kernel_args = msgspec.structs.replace(
            message.kernel_args,
            connection_info=connection_info,
            parent_pid=os.getpid(),
        )

        self._process = subprocess.Popen(
            [sys.executable, "-m", "marimo._ipc.launch_kernel"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=working_directory,
        )
        assert self._process.stdin is not None
        assert self._process.stdout is not None
        self._process.stdin.write(kernel_args.encode_json())
        self._process.stdin.flush()
        self._process.stdin.close()

        ready = self._process.stdout.readline().decode(errors="replace").strip()
        if ready != "KERNEL_READY":
            error = self._read_kernel_stderr()
            msg = f"Expected KERNEL_READY, received {ready!r}. {error}".strip()
            raise RuntimeError(msg)

        threading.Thread(target=self._forward_operations, daemon=True).start()
        threading.Thread(target=self._forward_stderr, daemon=True).start()
        _write_frame(Ready())

    def _forward_operations(self) -> None:
        assert self._queues is not None
        stream = self._queues.stream_queue
        if stream is None:
            return
        while not self._closed:
            message: KernelMessage | None = stream.get()
            if message is None:
                return
            _write_frame(Operation(message=msgspec.Raw(message)))

    def _forward_stderr(self) -> None:
        if self._process is None or self._process.stderr is None:
            return
        for line in self._process.stderr:
            _write_frame(Log(message=line.decode(errors="replace").rstrip()))

    def _read_kernel_stderr(self) -> str:
        if self._process is None or self._process.stderr is None:
            return ""
        return self._process.stderr.read().decode(errors="replace")

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
        """Interrupt the running kernel."""
        if self._process is None or self._process.poll() is not None:
            return
        assert self._queues is not None
        interrupt_queue = self._queues.win32_interrupt_queue
        if sys.platform == "win32" and interrupt_queue is not None:
            interrupt_queue.put_nowait(item=True)
        else:
            os.kill(self._process.pid, signal.SIGINT)

    def close(self) -> None:
        """Stop the kernel and release its queues."""
        if self._closed:
            return
        self._closed = True
        if self._queues is not None:
            with contextlib.suppress(Exception):
                self._queues.put_control_request(StopKernelCommand())
        if self._process is not None and self._process.poll() is None:
            try:
                self._process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                self._process.terminate()
                try:
                    self._process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    self._process.kill()
        if self._ipc_queues is not None:
            self._ipc_queues.close_queues()


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
