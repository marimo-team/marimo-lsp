# Copyright 2026 Marimo. All rights reserved.

"""Tests for live kernel sessions."""

from __future__ import annotations

import asyncio
import copy
import threading
from typing import TYPE_CHECKING, cast
from unittest.mock import AsyncMock, Mock

import pytest
from marimo._config.config import DEFAULT_CONFIG, MarimoConfig, RuntimeConfig
from marimo._messaging.types import KernelMessage
from marimo._runtime.commands import (
    CodeCompletionCommand,
    StopKernelCommand,
    UpdateUIElementCommand,
    UpdateUserConfigCommand,
)
from marimo._session.managers import IPCQueueManagerImpl
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t, RequestId, UIElementId

from marimo_lsp.kernels import KernelOpenError
from marimo_lsp.kernels.native import NativeKernel
from marimo_lsp.models import SessionInfo
from marimo_lsp.sessions import Session, Sessions, _OperationSink

if TYPE_CHECKING:
    from collections.abc import Callable


def _make_session() -> tuple[Session, Mock]:
    session = Session.__new__(Session)
    ipc_queue_manager = Mock()
    session._kernel = NativeKernel(
        IPCQueueManagerImpl.from_ipc(ipc_queue_manager),
        Mock(executable="python", working_directory="/workspace"),
    )
    session.session_view = SessionView()
    session._on_change = Mock()
    session._status = "idle"
    session._state_lock = threading.RLock()
    return session, ipc_queue_manager


def test_ui_element_updates_use_marimo_ipc_batching_route() -> None:
    session, queue_manager = _make_session()
    command = UpdateUIElementCommand(object_ids=[UIElementId("slider")], values=[1])

    session.put_control_request(command, from_consumer_id=None)

    queue_manager.control_queue.put.assert_called_once_with(command)
    queue_manager.set_ui_element_queue.put.assert_called_once_with(command)
    queue_manager.completion_queue.put.assert_not_called()


def test_control_requests_update_live_session_snapshot() -> None:
    session, _queue_manager = _make_session()
    session.session_view.mark_auto_export_html()
    command = UpdateUIElementCommand(object_ids=[UIElementId("slider")], values=[1])

    session.put_control_request(command, from_consumer_id=None)

    assert session.session_view.ui_values == {UIElementId("slider"): 1}
    assert session.session_view.needs_export("html")


def test_regular_commands_are_routed_to_control_queue_only() -> None:
    session, queue_manager = _make_session()
    command = StopKernelCommand()

    session.put_control_request(command, from_consumer_id=None)

    queue_manager.control_queue.put.assert_called_once_with(command)
    queue_manager.set_ui_element_queue.put.assert_not_called()
    queue_manager.completion_queue.put.assert_not_called()


def test_out_of_band_commands_are_routed_to_completion_queue() -> None:
    session, queue_manager = _make_session()
    session.session_view.mark_auto_export_html()
    command = CodeCompletionCommand(
        id=RequestId("request"), document="mo.", cell_id=CellId_t("cell")
    )

    session.put_control_request(command, from_consumer_id=None)

    queue_manager.completion_queue.put.assert_called_once_with(command)
    queue_manager.control_queue.put.assert_not_called()
    queue_manager.set_ui_element_queue.put.assert_not_called()
    assert not session.session_view.needs_export("html")


def test_detach_only_overrides_auto_reload() -> None:
    session, queue_manager = _make_session()
    default_runtime = cast("RuntimeConfig", DEFAULT_CONFIG.get("runtime", {}))
    configured = cast(
        "MarimoConfig",
        {
            **copy.deepcopy(DEFAULT_CONFIG),
            "runtime": {**default_runtime, "auto_reload": "autorun"},
        },
    )
    session._config_manager = Mock()
    session._config_manager.get_config.return_value = configured
    session._operation_sink = _OperationSink(Mock(), "file:///test.py")
    display = cast("dict[str, object]", configured.get("display", {}))
    runtime_config = cast(
        "MarimoConfig",
        {**configured, "display": {**display, "theme": "dark"}},
    )
    session._runtime_config = runtime_config

    session.detach()

    paused = queue_manager.control_queue.put.call_args_list[0].args[0]
    assert isinstance(paused, UpdateUserConfigCommand)
    paused_runtime = cast("RuntimeConfig", paused.config.get("runtime", {}))
    paused_display = cast("dict[str, object]", paused.config.get("display", {}))
    configured_runtime = cast("RuntimeConfig", configured.get("runtime", {}))
    assert paused_runtime.get("auto_reload") == "off"
    assert paused_display["theme"] == "dark"
    assert configured_runtime.get("auto_reload") == "autorun"
    assert not session.attached

    session.attach()

    restored = queue_manager.control_queue.put.call_args_list[1].args[0]
    assert isinstance(restored, UpdateUserConfigCommand)
    restored_runtime = cast("RuntimeConfig", restored.config.get("runtime", {}))
    restored_display = cast("dict[str, object]", restored.config.get("display", {}))
    assert restored_runtime.get("auto_reload") == "autorun"
    assert restored_display["theme"] == "dark"
    assert session.attached


def test_detached_session_keeps_auto_reload_paused_after_config_update() -> None:
    session, queue_manager = _make_session()
    session._config_manager = Mock()
    session._operation_sink = _OperationSink(Mock(), "file:///test.py")
    session._operation_sink.detach()
    configured = cast(
        "MarimoConfig",
        {"runtime": {"auto_reload": "autorun"}},
    )

    session.update_runtime_config(configured)

    command = queue_manager.control_queue.put.call_args.args[0]
    assert isinstance(command, UpdateUserConfigCommand)
    runtime = cast("RuntimeConfig", command.config.get("runtime", {}))
    assert runtime.get("auto_reload") == "off"


def test_detached_operation_sink_drops_messages_until_reattached() -> None:
    server = Mock()
    sink = _OperationSink(server, "file:///test.py")
    message = KernelMessage(b'{"op": "completed-run", "run_id": null}')

    sink.detach()
    sink.notify(message)

    server.protocol.notify.assert_not_called()

    sink.attach()
    sink.notify(message)

    server.protocol.notify.assert_called_once_with(
        "marimo/operation",
        {
            "notebookUri": "file:///test.py",
            "operation": {"op": "completed-run", "run_id": None},
        },
    )


def test_session_status_tracks_running_and_completed_operations() -> None:
    session, _ = _make_session()

    session._update_status(KernelMessage(b'{"op": "cell-op", "status": "running"}'))
    assert session._status == "running"

    session._update_status(KernelMessage(b'{"op": "completed-run"}'))
    assert session._status == "idle"
    assert session._on_change.call_count == 2


def test_terminal_kernel_error_removes_live_session() -> None:
    server = Mock()
    sessions = Sessions(server, kernels=Mock())
    session = Mock(spec=Session)
    sessions._sessions["file:///test.py"] = session
    sessions._notify_changed = Mock()

    sessions._kernel_failed(session, "bridge exited")

    assert sessions.get("file:///test.py") is None
    session.close.assert_called_once_with()
    sessions._notify_changed.assert_called_once_with()


def test_terminal_kernel_operation_invokes_failure_callback() -> None:
    session, _queue_manager = _make_session()
    session._closed = False
    session._operation_sink = Mock()
    session._on_kernel_failure = Mock()
    message = KernelMessage(b'{"op": "kernel-startup-error", "error": "bridge exited"}')

    session.accept_kernel_message(message)

    session._on_kernel_failure.assert_called_once_with(session, "bridge exited")
    session._operation_sink.notify.assert_called_once_with(message)


def test_sessions_changed_notification_contains_public_snapshot() -> None:
    server = Mock()
    sessions = Sessions(server, kernels=Mock())
    session = Mock(spec=Session)
    session.describe.return_value = SessionInfo(
        session_id="session",
        notebook_uri="file:///test.py",
        filename="test.py",
        executable="/usr/bin/python",
        working_directory="/workspace",
        started_at=42,
        status="idle",
        attached=False,
    )
    sessions._sessions["file:///test.py"] = session

    sessions._notify_changed()

    server.protocol.notify.assert_called_once_with(
        "marimo/sessionsChanged",
        {
            "sessions": [
                {
                    "sessionId": "session",
                    "notebookUri": "file:///test.py",
                    "filename": "test.py",
                    "executable": "/usr/bin/python",
                    "workingDirectory": "/workspace",
                    "startedAt": 42,
                    "status": "idle",
                    "attached": False,
                }
            ]
        },
    )


@pytest.mark.asyncio
async def test_start_reuses_session_with_same_executable() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    current = Mock(spec=Session)
    current.executable = "/usr/bin/python"
    sessions._sessions["file:///test.py"] = current
    sessions._create = AsyncMock()

    result = await sessions.start("file:///test.py", "/usr/bin/python", "/workspace")

    assert result is current
    current.attach.assert_called_once_with()
    sessions._create.assert_not_called()


@pytest.mark.asyncio
async def test_start_reuses_same_executable_despite_new_working_directory() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    current = Mock(spec=Session)
    current.executable = "/usr/bin/python"
    sessions._sessions["file:///test.py"] = current
    sessions._create = AsyncMock()

    result = await sessions.start(
        "file:///test.py", "/usr/bin/python", "/new/working/directory"
    )

    assert result is current
    current.attach.assert_called_once_with()
    sessions._create.assert_not_called()


@pytest.mark.asyncio
async def test_start_replaces_session_after_replacement_starts() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    current = Mock(spec=Session)
    current.executable = "/old/python"
    replacement = Mock(spec=Session)
    replacement.describe.return_value = Mock()
    sessions._sessions["file:///test.py"] = current
    sessions._create = AsyncMock(return_value=replacement)
    sessions._notify_changed = Mock()

    result = await sessions.start("file:///test.py", "/new/python", "/workspace")

    assert result is replacement
    assert sessions.get("file:///test.py") is replacement
    current.close.assert_called_once_with()
    sessions._notify_changed.assert_called_once_with()


@pytest.mark.asyncio
async def test_failed_replacement_preserves_existing_session() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    current = Mock(spec=Session)
    current.executable = "/old/python"
    sessions._sessions["file:///test.py"] = current
    sessions._create = AsyncMock(side_effect=RuntimeError("failed to start"))

    with pytest.raises(RuntimeError, match="failed to start"):
        await sessions.start("file:///test.py", "/new/python", "/workspace")

    assert sessions.get("file:///test.py") is current
    current.close.assert_not_called()


@pytest.mark.asyncio
async def test_concurrent_starts_share_one_kernel_launch() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    launch_started = asyncio.Event()
    finish_launch = asyncio.Event()
    replacement = Mock(spec=Session)
    replacement.executable = "/usr/bin/python"
    replacement.describe.return_value = Mock()

    async def create(*_args: object, **_kwargs: object) -> Session:
        launch_started.set()
        await finish_launch.wait()
        return replacement

    sessions._create = AsyncMock(side_effect=create)
    sessions._notify_changed = Mock()

    first = asyncio.create_task(
        sessions.start("file:///test.py", "/usr/bin/python", "/workspace")
    )
    await launch_started.wait()
    second = asyncio.create_task(
        sessions.start("file:///test.py", "/usr/bin/python", "/workspace")
    )
    await asyncio.sleep(0)

    sessions._create.assert_awaited_once()
    finish_launch.set()

    assert await first is replacement
    assert await second is replacement
    sessions._create.assert_awaited_once()


@pytest.mark.asyncio
async def test_close_during_start_discards_launched_kernel() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    launch_started = asyncio.Event()
    finish_launch = asyncio.Event()
    replacement = Mock(spec=Session)

    async def create(*_args: object, **_kwargs: object) -> Session:
        launch_started.set()
        await finish_launch.wait()
        return replacement

    sessions._create = AsyncMock(side_effect=create)
    start = asyncio.create_task(
        sessions.start("file:///test.py", "/usr/bin/python", "/workspace")
    )
    await launch_started.wait()

    sessions.close("file:///test.py")
    finish_launch.set()

    with pytest.raises(KernelOpenError, match="changed while its kernel was starting"):
        await start
    assert sessions.get("file:///test.py") is None
    replacement.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_session_creation_failure_closes_launched_kernel() -> None:
    kernel = Mock()
    kernels = Mock()
    kernels.launch = AsyncMock(return_value=kernel)
    sessions = Sessions(Mock(), kernels=kernels)
    previous = Mock(spec=Session)
    previous.app_file_manager = Mock()
    previous.config_manager = Mock()
    previous.config_manager.get_config.side_effect = RuntimeError("bad config")
    previous.session_view = Mock()
    previous.started_at = 42

    with pytest.raises(RuntimeError, match="bad config"):
        await sessions._create(
            "file:///test.py",
            "/usr/bin/python",
            "/workspace",
            previous=previous,
        )

    kernel.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_startup_message_handoff_preserves_order(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = KernelMessage(b'{"op": "first"}')
    second = KernelMessage(b'{"op": "second"}')
    third = KernelMessage(b'{"op": "third"}')
    kernel = Mock()
    receive_callback: list[Callable[[KernelMessage], None]] = []

    async def launch(**kwargs: object) -> object:
        receive = cast("Callable[[KernelMessage], None]", kwargs["receive"])
        receive_callback.append(receive)
        delivered = threading.Event()

        def deliver_initial_messages() -> None:
            receive(first)
            receive(second)
            delivered.set()

        threading.Thread(target=deliver_initial_messages, daemon=True).start()
        assert await asyncio.to_thread(delivered.wait, 1)
        return kernel

    kernels = Mock()
    kernels.launch = AsyncMock(side_effect=launch)
    sessions = Sessions(Mock(), kernels=kernels)
    previous = Mock(spec=Session)
    previous.app_file_manager = Mock()
    previous.config_manager = Mock()
    previous.config_manager.get_config.return_value = DEFAULT_CONFIG
    previous.session_view = Mock()
    previous.started_at = 42
    loop_thread = threading.get_ident()
    observed: list[tuple[KernelMessage, int]] = []
    third_delivered = asyncio.Event()

    def accept(_session: Session, message: KernelMessage) -> None:
        observed.append((message, threading.get_ident()))
        if message == third:
            third_delivered.set()

    monkeypatch.setattr(Session, "accept_kernel_message", accept)

    await sessions._create(
        "file:///test.py",
        "/usr/bin/python",
        "/workspace",
        previous=previous,
    )
    threading.Thread(target=receive_callback[0], args=(third,), daemon=True).start()
    await asyncio.wait_for(third_delivered.wait(), timeout=1)

    assert observed == [
        (first, loop_thread),
        (second, loop_thread),
        (third, loop_thread),
    ]


@pytest.mark.asyncio
async def test_restart_replaces_kernel_without_reloading_closed_notebook() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    current = Mock(spec=Session)
    current.executable = "/usr/bin/python"
    current.working_directory = "/workspace"
    current.attached = False
    current.session_view = Mock()
    current.started_at = 42
    replacement = Mock(spec=Session)
    sessions._sessions["file:///test.py"] = current
    sessions._create = AsyncMock(return_value=replacement)
    sessions._notify_changed = Mock()

    result = await sessions.restart(
        "file:///test.py",
        executable="/usr/bin/python",
        working_directory="/workspace",
    )

    assert result is replacement
    sessions._create.assert_called_once_with(
        "file:///test.py",
        "/usr/bin/python",
        "/workspace",
        previous=current,
    )
    replacement.detach.assert_called_once_with(notify=False)
    current.close.assert_called_once_with()
    sessions._notify_changed.assert_called_once_with()


@pytest.mark.asyncio
async def test_restore_uses_requested_working_directory() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    replacement = Mock(spec=Session)
    sessions._create = AsyncMock(return_value=replacement)
    sessions._notify_changed = Mock()

    result = await sessions.restart(
        "file:///test.py",
        executable="/usr/bin/python",
        working_directory="/workspace",
        create_if_missing=True,
    )

    assert result is replacement
    sessions._create.assert_called_once_with(
        "file:///test.py", "/usr/bin/python", "/workspace"
    )


@pytest.mark.asyncio
async def test_restart_does_not_restore_a_missing_session() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    sessions._create = AsyncMock()

    result = await sessions.restart(
        "file:///test.py",
        executable="/usr/bin/python",
        working_directory="/workspace",
    )

    assert result is None
    sessions._create.assert_not_called()


def test_move_preserves_live_session() -> None:
    server = Mock()
    server.workspace.notebook_documents = {}
    sessions = Sessions(server, kernels=Mock())
    current = Mock(spec=Session)
    sessions._sessions["file:///old.py"] = current
    sessions._notify_changed = Mock()

    sessions.move("file:///old.py", "file:///new.py")

    assert sessions.get("file:///old.py") is None
    assert sessions.get("file:///new.py") is current
    current.move.assert_called_once_with("file:///new.py", notify=False)
    sessions._notify_changed.assert_called_once_with()


def test_close_all_clears_collection_and_notifies_once() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    first = Mock(spec=Session)
    second = Mock(spec=Session)
    sessions._sessions = {
        "file:///first.py": first,
        "file:///second.py": second,
    }
    sessions._notify_changed = Mock()

    sessions.close_all()

    assert list(sessions) == []
    first.close.assert_called_once_with()
    second.close.assert_called_once_with()
    sessions._notify_changed.assert_called_once_with()
