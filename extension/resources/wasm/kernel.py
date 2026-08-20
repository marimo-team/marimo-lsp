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
import collections
import contextlib
import json
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
_KERNEL_LAUNCH_CODE = """\
import json, runpy, marimo
print(json.dumps({"marimo_version": marimo.__version__}), flush=True)
runpy.run_module("marimo._ipc.launch_kernel", run_name="__main__")
"""


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
        self._stderr_tail: collections.deque[str] = collections.deque(maxlen=20)
        self._stderr_lock = threading.Lock()
        self._kernel_ready = False
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
        process = subprocess.Popen(  # noqa: S603 -- selected Python launches marimo
            [sys.executable, "-c", _KERNEL_LAUNCH_CODE],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=working_directory,
        )
        self._process = process
        assert process.stdin is not None
        process.stdin.write(kernel_args.encode_json())
        process.stdin.flush()
        process.stdin.close()

        # Drain stderr before waiting for readiness so a noisy child cannot
        # fill its pipe and deadlock startup.
        threading.Thread(target=self._forward_stderr, daemon=True).start()
        version_line = self._wait_for_kernel_ready()
        try:
            version_payload = json.loads(version_line)
        except json.JSONDecodeError as error:
            msg = f"Invalid kernel version response: {version_line!r}"
            raise RuntimeError(self._with_stderr_tail(msg)) from error
        marimo_version = (
            version_payload.get("marimo_version")
            if isinstance(version_payload, dict)
            else None
        )
        if not isinstance(marimo_version, str):
            msg = f"Invalid kernel version response: {version_line!r}"
            raise TypeError(self._with_stderr_tail(msg))

        ready = self._wait_for_kernel_ready()
        if ready != "KERNEL_READY":
            msg = f"Expected KERNEL_READY, received {ready!r}"
            raise RuntimeError(self._with_stderr_tail(msg))
        self._kernel_ready = True

        # Failures before this point are reported by start() alone. Exits
        # after it are reported by this watcher alone, which cannot exist
        # during startup.
        threading.Thread(target=self._watch_kernel_exit, daemon=True).start()
        threading.Thread(target=self._forward_operations, daemon=True).start()
        _write_frame(Ready(marimo_version=marimo_version))

    def _with_stderr_tail(self, message: str) -> str:
        with self._stderr_lock:
            tail = "\n".join(self._stderr_tail)
        if tail:
            return f"{message}\nKernel stderr:\n{tail}"
        return message

    def _wait_for_kernel_ready(
        self,
        timeout: float = KERNEL_READY_TIMEOUT,
    ) -> str:
        """Read the readiness line without allowing startup to hang forever."""
        assert self._process is not None
        stdout = self._process.stdout
        assert stdout is not None
        result: queue.Queue[str | Exception] = queue.Queue(maxsize=1)

        def read_ready() -> None:
            try:
                ready = stdout.readline().decode(errors="replace").strip()
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
        """Relay kernel stderr lines as logs."""
        process = self._process
        if process is None or process.stderr is None:
            return
        for line in process.stderr:
            text = line.decode(errors="replace").rstrip()
            with self._stderr_lock:
                self._stderr_tail.append(text)
            _write_frame(Log(message=text))

    def _watch_kernel_exit(self) -> None:
        """Report a kernel that exits after it became ready."""
        assert self._process is not None
        code = self._process.wait()
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
        process = self._process
        if process is not None and process.poll() is None:
            # Only ask a ready kernel to stop. Before readiness the control
            # socket may have no connected peer, and the zmq send would block
            # instead of being dropped.
            if self._queues is not None and self._kernel_ready:
                with contextlib.suppress(Exception):
                    self._queues.put_control_request(StopKernelCommand())
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        process.wait(timeout=2)
            if process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
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
