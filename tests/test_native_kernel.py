# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import asyncio
import threading
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import AsyncMock, Mock

import pytest

from marimo_lsp.kernels.manager import Manager, launch_kernel
from marimo_lsp.kernels.native import NativeKernel, NativeKernels

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
    launched = Mock(
        marimo_version="1.2.3-rc1+build.7",
        session_cache_path=str(tmp_path / "session.json"),
    )
    launch = Mock(return_value=launched)
    monkeypatch.setattr("marimo_lsp.kernels.manager.launch_kernel", launch)
    selected = tmp_path / "selected"
    selected.mkdir()

    manager = _manager(tmp_path / "notebook.py", str(selected))
    manager.start_kernel()

    assert launch.call_args.kwargs["cwd"] == str(selected)
    assert manager.marimo_version == "1.2.3-rc1+build.7"
    assert manager.session_cache_path == str(tmp_path / "session.json")


@pytest.mark.asyncio
async def test_native_kernel_reuses_the_startup_cache_path() -> None:
    manager = Mock(
        executable="/python",
        working_directory="/workspace",
        app_metadata=Mock(filename="/workspace/notebook.py"),
        session_cache_path="/workspace/__marimo__/session/notebook.py.json",
    )
    kernel = NativeKernel(Mock(), manager)

    assert (
        await kernel.locate_saved_session("/workspace/notebook.py")
        == "/workspace/__marimo__/session/notebook.py.json"
    )


@pytest.mark.asyncio
async def test_native_kernel_resolves_a_renamed_notebook_in_selected_python(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    manager = Mock(
        executable="/python",
        working_directory="/workspace",
        app_metadata=Mock(filename="/workspace/notebook.py"),
        session_cache_path="/workspace/__marimo__/session/notebook.py.json",
    )
    kernel = NativeKernel(Mock(), manager)
    process = Mock(returncode=0)
    process.communicate = AsyncMock(
        return_value=(b'"/workspace/__marimo__/session/renamed.py.json"', b"")
    )
    launch = AsyncMock(return_value=process)
    monkeypatch.setattr(asyncio, "create_subprocess_exec", launch)

    located = await kernel.locate_saved_session("/workspace/renamed.py")

    assert located == "/workspace/__marimo__/session/renamed.py.json"
    assert launch.call_args.args[:2] == ("/python", "-c")
    assert launch.call_args.args[3] == "/workspace/renamed.py"
    assert launch.call_args.kwargs["cwd"] == "/workspace"


def test_kernel_reports_exact_marimo_version_from_launched_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = Mock()
    process.stdout.readline.side_effect = [
        (
            b'{"marimo_version":"1.2.3-rc1+build.7",'
            b'"session_cache_path":"/workspace/__marimo__/session/notebook.py.json"}\n'
        ),
        b"KERNEL_READY\n",
    ]
    popen = Mock(return_value=process)
    monkeypatch.setattr("marimo_lsp.kernels.manager.subprocess.Popen", popen)
    args = Mock()
    args.app_metadata.filename = "/workspace/notebook.py"
    args.encode_json.return_value = b"{}"

    kernel_process = launch_kernel("/python", args, cwd="/workspace")

    assert kernel_process.marimo_version == "1.2.3-rc1+build.7"
    assert (
        kernel_process.session_cache_path
        == "/workspace/__marimo__/session/notebook.py.json"
    )
    command = popen.call_args.args[0]
    assert command[:2] == ["/python", "-c"]
    assert "runpy.run_module" in command[2]
    assert command[3] == "/workspace/notebook.py"
    assert popen.call_args.kwargs["cwd"] == "/workspace"


def test_kernel_treats_unknown_marimo_version_as_unavailable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = Mock()
    process.stdout.readline.side_effect = [
        b'{"marimo_version":"unknown"}\n',
        b"KERNEL_READY\n",
    ]
    monkeypatch.setattr(
        "marimo_lsp.kernels.manager.subprocess.Popen",
        Mock(return_value=process),
    )
    args = Mock()
    args.encode_json.return_value = b"{}"

    kernel_process = launch_kernel("/python", args)

    assert kernel_process.marimo_version is None


@pytest.mark.parametrize(
    ("version_line", "error_type"),
    [
        (b"", RuntimeError),
        (b"not-json\n", RuntimeError),
        (b'{"marimo_version": 123}\n', TypeError),
    ],
)
def test_invalid_kernel_version_response_cleans_up_process(
    version_line: bytes,
    error_type: type[Exception],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = Mock()
    process.stdout.readline.return_value = version_line
    process.stderr.read.return_value = b"bootstrap failed"
    process.poll.side_effect = [None, 1]
    monkeypatch.setattr(
        "marimo_lsp.kernels.manager.subprocess.Popen",
        Mock(return_value=process),
    )
    args = Mock()
    args.encode_json.return_value = b"{}"

    with pytest.raises(error_type, match="bootstrap failed"):
        launch_kernel("/python", args)

    process.terminate.assert_called_once_with()
    process.wait.assert_called_once()


def test_invalid_ready_response_cleans_up_process(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = Mock()
    process.stdout.readline.side_effect = [
        b'{"marimo_version":"1.2.3"}\n',
        b"NOT_READY\n",
    ]
    process.stderr.read.return_value = b"kernel failed"
    process.poll.side_effect = [None, None, 1]
    monkeypatch.setattr(
        "marimo_lsp.kernels.manager.subprocess.Popen",
        Mock(return_value=process),
    )
    args = Mock()
    args.encode_json.return_value = b"{}"

    with pytest.raises(RuntimeError, match="kernel failed"):
        launch_kernel("/python", args)

    process.terminate.assert_called_once_with()
    process.wait.assert_called_once()


@pytest.mark.parametrize("failure", ["write", "decode"])
def test_unexpected_bootstrap_failure_cleans_up_process(
    failure: str,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    process = Mock()
    process.poll.return_value = None
    if failure == "write":
        process.stdin.write.side_effect = BrokenPipeError("closed pipe")
        error_type = BrokenPipeError
    else:
        process.stdout.readline.return_value = b"\xff\n"
        error_type = UnicodeDecodeError
    monkeypatch.setattr(
        "marimo_lsp.kernels.manager.subprocess.Popen",
        Mock(return_value=process),
    )
    args = Mock()
    args.encode_json.return_value = b"{}"

    with pytest.raises(error_type):
        launch_kernel("/python", args)

    process.terminate.assert_called_once_with()
    process.wait.assert_called_once()


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
async def test_failed_launch_closes_queues_without_a_started_kernel(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    queue_manager = Mock()
    manager = Mock()
    manager.kernel_task = None
    manager.start_kernel.side_effect = RuntimeError("launch failed")

    monkeypatch.setattr(
        "marimo_lsp.kernels.native.IpcQueues.create",
        Mock(return_value=(Mock(), Mock())),
    )
    monkeypatch.setattr(
        "marimo_lsp.kernels.native.IpcQueueManager.from_ipc",
        Mock(return_value=queue_manager),
    )
    monkeypatch.setattr(
        "marimo_lsp.kernels.native.Manager",
        Mock(return_value=manager),
    )

    with pytest.raises(RuntimeError, match="launch failed"):
        await NativeKernels().launch(
            executable="python",
            working_directory="/workspace",
            app_file_manager=Mock(),
            config_manager=Mock(),
            receive=Mock(),
        )

    manager.close_kernel.assert_not_called()
    queue_manager.close_queues.assert_called_once_with()


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
