# Copyright 2026 Marimo. All rights reserved.

"""Run a marimo kernel behind the WASM language server's stdio protocol.

This script runs in the notebook's selected Python. It owns marimo IPC and
ZeroMQ; Node only brokers its opaque stdin and stdout bytes.

The kernel is launched with ``subprocess``, the same path as the native
language server. ``multiprocessing`` spawn is deliberately avoided: on
Windows it starts children with dangling standard handle values, which later
alias live pipes inside the kernel and stall anything that touches a
standard stream -- cell subprocesses (marimo-lsp#734) and the CRT
initialization of extension-module DLLs during imports (marimo-lsp#763).
"""

from __future__ import annotations

import atexit
import contextlib
import os
import queue
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
    MAX_FRAME_SIZE,
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
KERNEL_READY_TIMEOUT = 10.0


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
    """Own one native kernel subprocess and its marimo IPC queues."""

    def __init__(self) -> None:
        self._queues: IPCQueueManagerImpl | None = None
        self._ipc_queues: ipc.QueueManager | None = None
        self._process: subprocess.Popen[bytes] | None = None
        self._closed = False

    def start(self, message: Start) -> None:
        """Create IPC queues and start the kernel subprocess."""
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

        # Piped standard streams make CreateProcess hand the kernel real
        # handles, so its fds 0-2 are valid from birth.
        self._process = subprocess.Popen(
            [sys.executable, "-m", "marimo._ipc.launch_kernel"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=working_directory,
        )
        assert self._process.stdin is not None
        self._process.stdin.write(kernel_args.encode_json())
        self._process.stdin.flush()
        self._process.stdin.close()

        # Drain stderr before waiting for readiness so a noisy child cannot
        # fill its pipe and deadlock startup.
        threading.Thread(target=self._forward_stderr, daemon=True).start()
        ready = self._wait_for_kernel_ready()
        if ready != "KERNEL_READY":
            msg = f"Expected KERNEL_READY, received {ready!r}"
            raise RuntimeError(msg)

        threading.Thread(target=self._forward_operations, daemon=True).start()
        _write_frame(Ready())

    def _wait_for_kernel_ready(
        self,
        timeout: float = KERNEL_READY_TIMEOUT,
    ) -> str:
        """Read the readiness line without allowing startup to hang forever."""
        assert self._process is not None
        assert self._process.stdout is not None
        result: queue.Queue[str | Exception] = queue.Queue(maxsize=1)

        def read_ready() -> None:
            try:
                ready = self._process.stdout.readline().decode(errors="replace").strip()
                result.put(ready)
            except Exception as error:  # noqa: BLE001
                result.put(error)

        threading.Thread(target=read_ready, daemon=True).start()
        try:
            ready = result.get(timeout=timeout)
        except queue.Empty as error:
            msg = f"Kernel did not become ready within {timeout:g} seconds"
            raise TimeoutError(msg) from error
        if isinstance(ready, Exception):
            raise ready
        return ready

    def _forward_operations(self) -> None:
        assert self._queues is not None
        stream_queue = self._queues.stream_queue
        if stream_queue is None:
            return
        while not self._closed:
            try:
                message: KernelMessage | None = stream_queue.get(timeout=0.1)
            except queue.Empty:
                continue
            if message is None:
                return
            _write_frame(Operation(message=msgspec.Raw(message)))

    def _forward_stderr(self) -> None:
        """Relay kernel stderr as logs and report an unexpected exit."""
        process = self._process
        if process is None or process.stderr is None:
            return
        for line in process.stderr:
            _write_frame(Log(message=line.decode(errors="replace").rstrip()))
        code = process.wait()
        if not self._closed:
            _write_frame(
                Error(message=f"Kernel process exited unexpectedly (code={code})")
            )

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
            interrupt_queue.put_nowait(True)  # noqa: FBT003
        else:
            os.kill(self._process.pid, signal.SIGINT)

    def close(self) -> None:
        """Stop the kernel exactly once and release its queues."""
        if self._closed:
            return
        self._closed = True
        # Only ask a live kernel to stop: with no connected peer, the zmq
        # send would block instead of being dropped.
        if (
            self._queues is not None
            and self._process is not None
            and self._process.poll() is None
        ):
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
