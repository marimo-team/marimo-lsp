# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import importlib.util
import io
import json
import logging
import os
import queue
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest
from marimo._ast.app_config import _AppConfig
from marimo._config.config import DEFAULT_CONFIG
from marimo._runtime.commands import AppMetadata, ExecuteCellsCommand
from marimo._types.ids import CellId_t

from marimo_lsp.wasm.protocol import (
    Control,
    Decoder,
    FromBridge,
    KernelLaunchArgs,
    Operation,
    Ready,
    Start,
    encode,
)

if TYPE_CHECKING:
    from collections.abc import Callable
    from types import ModuleType

BRIDGE_SCRIPT = (
    Path(__file__).parents[1] / "extension" / "resources" / "wasm" / "kernel.py"
)


def _load_bridge_module(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    resource_directory = Path(__file__).parents[1] / "extension" / "resources" / "wasm"
    monkeypatch.syspath_prepend(str(resource_directory))
    spec = importlib.util.spec_from_file_location(
        "marimo_lsp_test_wasm_bridge",
        resource_directory / "kernel.py",
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_windows_interrupt_uses_positional_queue_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    bridge = bridge_module._Bridge()
    bridge._process = Mock(pid=42)
    bridge._process.poll.return_value = None
    bridge._queues = Mock()
    interrupt_queue = bridge._queues.win32_interrupt_queue
    monkeypatch.setattr(sys, "platform", "win32")

    bridge.interrupt()

    interrupt_queue.put_nowait.assert_called_once_with(True)  # noqa: FBT003


def test_watcher_reports_a_kernel_that_exits_after_readiness(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    write_frame = Mock()
    monkeypatch.setattr(bridge_module, "_write_frame", write_frame)
    bridge = bridge_module._Bridge()
    bridge._process = Mock()
    bridge._process.wait.return_value = 3

    bridge._watch_kernel_exit()

    error = write_frame.call_args.args[0]
    assert isinstance(error, bridge_module.Error)
    assert "code=3" in error.message


def test_watcher_stays_quiet_once_the_bridge_is_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    write_frame = Mock()
    monkeypatch.setattr(bridge_module, "_write_frame", write_frame)
    bridge = bridge_module._Bridge()
    bridge._process = Mock()
    bridge._process.wait.return_value = 0
    bridge._closed = True

    bridge._watch_kernel_exit()

    write_frame.assert_not_called()


def test_close_terminates_an_unready_kernel_without_a_stop_command(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A kernel that never became ready has no connected control socket, so
    the stop command would block. close() must go straight to terminate."""
    bridge_module = _load_bridge_module(monkeypatch)
    bridge = bridge_module._Bridge()
    process = Mock()
    process.poll.return_value = None
    bridge._process = process
    bridge._queues = Mock()
    bridge._ipc_queues = Mock()

    bridge.close()

    bridge._queues.put_control_request.assert_not_called()
    process.terminate.assert_called_once_with()
    bridge._ipc_queues.close_queues.assert_called_once_with()


def test_close_asks_a_ready_kernel_to_stop(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    bridge = bridge_module._Bridge()
    process = Mock()
    process.poll.return_value = None
    bridge._process = process
    bridge._queues = Mock()
    bridge._ipc_queues = Mock()
    bridge._kernel_ready = True

    bridge.close()

    request = bridge._queues.put_control_request.call_args.args[0]
    assert isinstance(request, bridge_module.StopKernelCommand)


def test_kernel_readiness_has_a_timeout(monkeypatch: pytest.MonkeyPatch) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    bridge = bridge_module._Bridge()
    release_reader = threading.Event()
    bridge._process = Mock()
    bridge._process.stdout.readline.side_effect = lambda: (
        release_reader.wait(),
        b"KERNEL_READY\n",
    )[1]

    with pytest.raises(TimeoutError, match="did not become ready"):
        bridge._wait_for_kernel_ready(timeout=0.01)

    release_reader.set()


def test_bridge_launches_kernel_subprocess_over_marimo_ipc(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    """The kernel is a plain subprocess with piped standard streams.

    Pinning the launch path guards against reintroducing multiprocessing
    spawn, whose dangling standard handle values hang cell subprocesses
    (marimo-lsp#734) and DLL initialization during imports (marimo-lsp#763)
    on Windows.
    """
    bridge_module = _load_bridge_module(monkeypatch)
    process = Mock()
    process.stdout.readline.return_value = b"KERNEL_READY\n"
    process.stderr = None
    popen = Mock(return_value=process)
    write_frame = Mock()
    monkeypatch.setattr(bridge_module.subprocess, "Popen", popen)
    monkeypatch.setattr(bridge_module, "_write_frame", write_frame)
    bridge = bridge_module._Bridge()

    try:
        bridge.start(_start_frame(tmp_path))

        popen.assert_called_once()
        command = popen.call_args.args[0]
        assert command == [sys.executable, "-m", "marimo._ipc.launch_kernel"]
        assert popen.call_args.kwargs["cwd"] == str(tmp_path)
        assert popen.call_args.kwargs["stdin"] is bridge_module.subprocess.PIPE
        assert popen.call_args.kwargs["stdout"] is bridge_module.subprocess.PIPE
        assert popen.call_args.kwargs["stderr"] is bridge_module.subprocess.PIPE
        sent = KernelLaunchArgs.decode_json(process.stdin.write.call_args.args[0])
        assert sent.connection_info is not None
        assert sent.parent_pid == os.getpid()
        write_frame.assert_any_call(bridge_module.Ready())
    finally:
        bridge.close()


class _BridgeProcess:
    """Drive the real kernel bridge over framed stdio, as the extension does."""

    def __init__(self, working_directory: Path) -> None:
        self._stderr = tempfile.TemporaryFile()  # noqa: SIM115 - closed in close().
        self.child = subprocess.Popen(  # noqa: S603
            [sys.executable, str(BRIDGE_SCRIPT)],
            cwd=str(working_directory),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._stderr,
        )
        assert self.child.stdin is not None
        assert self.child.stdout is not None
        self.frames: queue.Queue[FromBridge | None] = queue.Queue()
        threading.Thread(target=self._read_frames, daemon=True).start()

    def _read_frames(self) -> None:
        stdout = self.child.stdout
        # Popen with binary stdout=PIPE hands back a BufferedReader, whose
        # read1 returns whatever bytes are available instead of blocking for
        # a full buffer.
        assert isinstance(stdout, io.BufferedReader)
        decoder = Decoder(FromBridge)
        while True:
            chunk = stdout.read1(65536)
            if not chunk:
                self.frames.put(None)
                return
            for message in decoder.feed(chunk):
                self.frames.put(message)

    def _failure_details(self, received: list[FromBridge]) -> str:
        self._stderr.seek(0)
        stderr = self._stderr.read().decode(errors="replace")
        if stderr:
            return f"received: {received}; bridge stderr:\n{stderr}"
        return f"received: {received}; bridge stderr was empty"

    def send(self, message: Start | Control) -> None:
        assert self.child.stdin is not None
        self.child.stdin.write(encode(message))
        self.child.stdin.flush()

    def wait_for(
        self,
        predicate: Callable[[FromBridge], bool],
        timeout: float,
    ) -> list[FromBridge]:
        """Collect frames until one matches; fail with what arrived so far."""
        received: list[FromBridge] = []
        deadline = time.monotonic() + timeout
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                pytest.fail(
                    f"No matching frame within {timeout}s; "
                    f"{self._failure_details(received)}"
                )
            try:
                message = self.frames.get(timeout=remaining)
            except queue.Empty:
                continue
            if message is None:
                pytest.fail(f"Bridge closed stdout; {self._failure_details(received)}")
            received.append(message)
            if predicate(message):
                return received

    def close(self) -> None:
        if self.child.stdin is not None and not self.child.stdin.closed:
            self.child.stdin.close()
        try:
            self.child.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.child.kill()
            self.child.wait()
        self._stderr.close()


def _start_frame(working_directory: Path) -> Start:
    return Start(
        working_directory=str(working_directory),
        kernel_args=KernelLaunchArgs(
            configs={},
            app_metadata=AppMetadata(
                query_params={},
                filename=str(working_directory / "notebook.py"),
                cli_args={},
                argv=None,
                app_config=_AppConfig(),
            ),
            user_config=DEFAULT_CONFIG,
            log_level=logging.WARNING,
            profile_path=None,
        ),
    )


def _operation(message: FromBridge) -> dict[str, object] | None:
    if not isinstance(message, Operation):
        return None
    decoded = json.loads(bytes(message.message))
    assert isinstance(decoded, dict)
    return decoded


def _is_completed_run(message: FromBridge) -> bool:
    operation = _operation(message)
    return operation is not None and operation.get("op") == "completed-run"


def _console_text(received: list[FromBridge]) -> str:
    """Concatenate the console output carried by cell-op operations."""
    chunks: list[str] = []
    for message in received:
        operation = _operation(message)
        if operation is None:
            continue
        console = operation.get("console")
        if not isinstance(console, dict):
            continue
        data = console.get("data")
        if isinstance(data, str):
            chunks.append(data)
    return "".join(chunks)


def test_cell_running_subprocess_completes_without_further_messages(
    tmp_path: Path,
) -> None:
    """After one execute request and no other messages, completed-run arrives.

    Regression test for marimo-lsp#734: on Windows the kernel process handed
    cell subprocesses dangling standard handles, so a cell calling
    ``subprocess.run(...)`` stalled until the *next* control message happened
    to arrive (the reporter's workaround was running ``print(123)`` in another
    cell). The client here goes silent after the execute request, so the run
    can only complete if cell subprocesses no longer depend on that stimulus.
    """
    bridge = _BridgeProcess(tmp_path)
    try:
        bridge.send(_start_frame(tmp_path))
        bridge.wait_for(lambda m: isinstance(m, Ready), timeout=90)

        code = (
            "import subprocess, sys\n"
            "completed = subprocess.run(\n"
            "    [sys.executable, '-c', 'print(\"sub-ok\")'],\n"
            "    capture_output=True,\n"
            "    check=True,\n"
            ")\n"
            "print('cell finished', completed.stdout.decode().strip())"
        )
        bridge.send(
            Control(
                request=ExecuteCellsCommand(cell_ids=[CellId_t("c1")], codes=[code])
            )
        )
        received = bridge.wait_for(_is_completed_run, timeout=60)

        assert "cell finished sub-ok" in _console_text(received)
    finally:
        bridge.close()


def test_kernel_stdin_reads_eof_instead_of_hanging(tmp_path: Path) -> None:
    """The kernel's standard streams are real handles from birth.

    Regression test for marimo-lsp#763: multiprocessing spawn left the
    kernel's CRT fds 0-2 holding the bridge's dangling standard-handle
    values, which later aliased live IPC pipes inside the kernel. Anything
    touching a standard stream -- a cell subprocess, or the CRT
    initialization of numpy's OpenBLAS DLL during ``import scipy`` -- then
    blocked behind the aliased pipe's pending read until unrelated kernel
    traffic arrived (minutes in VS Code). With a real, already-drained stdin
    pipe, reading fd 0 returns EOF immediately.
    """
    bridge = _BridgeProcess(tmp_path)
    try:
        bridge.send(_start_frame(tmp_path))
        bridge.wait_for(lambda m: isinstance(m, Ready), timeout=90)

        code = "import os; print('stdin:', os.read(0, 1))"
        bridge.send(
            Control(
                request=ExecuteCellsCommand(cell_ids=[CellId_t("c1")], codes=[code])
            )
        )
        received = bridge.wait_for(_is_completed_run, timeout=60)

        assert "stdin: b''" in _console_text(received)
    finally:
        bridge.close()


def test_bridge_rejects_oversized_frame_before_reading_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    stream = Mock()
    stream.read.return_value = (bridge_module.MAX_FRAME_SIZE + 1).to_bytes(
        4, byteorder="big"
    )
    monkeypatch.setattr(bridge_module.sys, "stdin", SimpleNamespace(buffer=stream))

    with pytest.raises(ValueError, match="frame exceeds"):
        bridge_module._read_frame()

    stream.read.assert_called_once_with(bridge_module.HEADER_SIZE)
