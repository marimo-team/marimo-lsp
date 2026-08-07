# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from marimo_lsp.kernels.manager import Manager
from marimo_lsp.kernels.native import NativeKernels

if TYPE_CHECKING:
    from pathlib import Path


def _manager(notebook: Path, working_directory: str) -> Manager:
    manager = Manager.__new__(Manager)
    manager.executable = "/usr/bin/python"
    manager.connection_info = Mock()
    manager.configs = {}
    manager.app_metadata = SimpleNamespace(filename=str(notebook))
    manager.config_manager = Mock()
    manager.config_manager.get_config.return_value = {}
    manager.working_directory = working_directory
    return manager


def test_supplied_working_directory_reaches_launch_kernel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launch = Mock(return_value=Mock())
    monkeypatch.setattr("marimo_lsp.kernels.manager.launch_kernel", launch)
    selected = tmp_path / "selected"
    selected.mkdir()

    manager = _manager(tmp_path / "notebook.py", str(selected))
    manager.start_kernel()

    assert launch.call_args.kwargs["cwd"] == str(selected)


@pytest.mark.parametrize("kind", ["relative", "missing", "file"])
def test_invalid_working_directory_is_rejected(
    kind: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launch = Mock(return_value=Mock())
    monkeypatch.setattr("marimo_lsp.kernels.manager.launch_kernel", launch)
    if kind == "relative":
        selected = "relative/path"
    elif kind == "missing":
        selected = str(tmp_path / "missing")
    else:
        file = tmp_path / "file"
        file.write_text("")
        selected = str(file)

    manager = _manager(tmp_path / "notebook.py", selected)
    with pytest.raises(ValueError, match="working directory"):
        manager.start_kernel()

    launch.assert_not_called()


@pytest.mark.asyncio
async def test_cancelled_launch_closes_kernel_after_start_finishes(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    started = threading.Event()
    finish = threading.Event()
    closed = threading.Event()

    class FakeKernel:
        def __init__(self, *_args: object) -> None:
            pass

        def start(self, _receive: object) -> None:
            started.set()
            assert finish.wait(timeout=1)

        def close(self) -> None:
            closed.set()

    monkeypatch.setattr(
        "marimo_lsp.kernels.native.IpcQueues.create",
        Mock(return_value=(Mock(), Mock())),
    )
    monkeypatch.setattr(
        "marimo_lsp.kernels.native.IpcQueueManager.from_ipc", Mock(return_value=Mock())
    )
    monkeypatch.setattr("marimo_lsp.kernels.native.Manager", Mock(return_value=Mock()))
    monkeypatch.setattr("marimo_lsp.kernels.native.NativeKernel", FakeKernel)

    launch = asyncio.create_task(
        NativeKernels().launch(
            executable="python",
            working_directory="/workspace",
            app_file_manager=Mock(),
            config_manager=Mock(),
            receive=Mock(),
        )
    )
    assert await asyncio.to_thread(started.wait, 1)

    launch.cancel()
    with pytest.raises(asyncio.CancelledError):
        await launch
    assert not closed.is_set()

    finish.set()
    assert await asyncio.to_thread(closed.wait, 1)
