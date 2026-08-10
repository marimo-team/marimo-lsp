# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import importlib.util
import io
import json
import logging
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import ANY, Mock

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


def test_interrupt_delegates_to_marimo_kernel_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    bridge = bridge_module._Bridge()
    bridge._manager = Mock()

    bridge.interrupt()

    bridge._manager.interrupt_kernel.assert_called_once_with()


def test_bridge_uses_normal_edit_mode_multiprocessing_manager(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    queues = Mock()
    manager = Mock()
    manager.kernel_connection.recv.side_effect = EOFError
    queue_manager = Mock(return_value=queues)
    kernel_manager = Mock(return_value=manager)
    write_frame = Mock()
    monkeypatch.setattr(bridge_module, "QueueManagerImpl", queue_manager)
    monkeypatch.setattr(bridge_module, "KernelManagerImpl", kernel_manager)
    monkeypatch.setattr(bridge_module, "_write_frame", write_frame)
    bridge = bridge_module._Bridge()
    args = SimpleNamespace(
        configs={},
        app_metadata=Mock(),
        user_config=Mock(),
        redirect_console_to_browser=True,
    )

    bridge.start(
        SimpleNamespace(
            working_directory=str(tmp_path),
            kernel_args=args,
        )
    )
    assert bridge._operation_thread is not None
    bridge._operation_thread.join(timeout=1)

    queue_manager.assert_called_once_with(use_multiprocessing=True)
    kernel_manager.assert_called_once_with(
        queue_manager=queues,
        mode=bridge_module.SessionMode.EDIT,
        configs={},
        app_metadata=args.app_metadata,
        config_manager=ANY,
        virtual_file_storage=None,
        redirect_console_to_browser=True,
    )
    config_manager = kernel_manager.call_args.kwargs["config_manager"]
    assert isinstance(config_manager, bridge_module._StaticConfigManager)
    assert config_manager.get_config() is args.user_config
    manager.start_kernel.assert_called_once_with()
    write_frame.assert_any_call(bridge_module.Ready())


class _BridgeProcess:
    """Drive the real kernel bridge over framed stdio, as the extension does."""

    def __init__(self, working_directory: Path) -> None:
        self.child = subprocess.Popen(  # noqa: S603
            [sys.executable, str(BRIDGE_SCRIPT)],
            cwd=str(working_directory),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
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
                    f"No matching frame within {timeout}s; received: {received}"
                )
            try:
                message = self.frames.get(timeout=remaining)
            except queue.Empty:
                continue
            if message is None:
                pytest.fail(f"Bridge closed stdout; received: {received}")
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
