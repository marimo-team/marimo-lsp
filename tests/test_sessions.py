# Copyright 2026 Marimo. All rights reserved.

"""Tests for live kernel sessions."""

from __future__ import annotations

import asyncio
import copy
import json
import threading
from typing import TYPE_CHECKING, cast
from unittest.mock import AsyncMock, Mock

import pytest
from marimo._config.config import DEFAULT_CONFIG, MarimoConfig, RuntimeConfig
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._messaging.types import KernelMessage
from marimo._runtime.commands import (
    CodeCompletionCommand,
    ExecuteCellsCommand,
    StopKernelCommand,
    UpdateCellConfigCommand,
    UpdateUIElementCommand,
    UpdateUserConfigCommand,
)
from marimo._session.managers import IPCQueueManagerImpl
from marimo._session.requests import InstantiateNotebookRequest
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t, RequestId, SessionId, UIElementId

from marimo_lsp.kernels import KernelOpenError
from marimo_lsp.kernels.native import NativeKernel
from marimo_lsp.models import SessionInfo
from marimo_lsp.saved_sessions import (
    decode_saved_session_view,
    serialize_saved_session_view,
)
from marimo_lsp.sessions import Session, Sessions, _OperationSink

if TYPE_CHECKING:
    from collections.abc import Callable
    from pathlib import Path

    from marimo_lsp.kernels import Kernel


SESSION_ID = SessionId("00000000-0000-4000-8000-000000000001")


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
    session._idle = asyncio.Event()
    session._idle.set()
    session._scratchpad_running = False
    session._scratchpad_run_id = None
    session._closed = False
    session._activated = True
    session._saved_session_pending = False
    session._saved_session_writer = None
    session._saved_session_location = None
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


def test_sync_forwards_changed_document_configs_to_the_kernel() -> None:
    session, queue_manager = _make_session()
    session._notebook_uri = "file:///test.py"
    session._app_file_manager = Mock()
    session._app_file_manager.app.cell_manager.config_map.side_effect = [
        {CellId_t("cell-1"): Mock(asdict=Mock(return_value={"disabled": True}))},
        {CellId_t("cell-1"): Mock(asdict=Mock(return_value={"disabled": False}))},
    ]

    workspace = Mock()
    session.sync(workspace)

    session._app_file_manager.sync.assert_called_once_with(workspace)
    command = queue_manager.control_queue.put.call_args.args[0]
    assert isinstance(command, UpdateCellConfigCommand)
    assert command.configs == {CellId_t("cell-1"): {"disabled": False}}


def test_sync_forwards_each_changed_config_separately() -> None:
    session, queue_manager = _make_session()
    session._notebook_uri = "file:///test.py"
    session._app_file_manager = Mock()
    session._app_file_manager.app.cell_manager.config_map.side_effect = [
        {
            CellId_t("cell-1"): Mock(asdict=Mock(return_value={"disabled": True})),
            CellId_t("cell-2"): Mock(asdict=Mock(return_value={"disabled": True})),
        },
        {
            CellId_t("cell-1"): Mock(asdict=Mock(return_value={"disabled": False})),
            CellId_t("cell-2"): Mock(asdict=Mock(return_value={"disabled": False})),
        },
    ]

    session.sync(Mock())

    commands = [call.args[0] for call in queue_manager.control_queue.put.call_args_list]
    assert [command.configs for command in commands] == [
        {CellId_t("cell-1"): {"disabled": False}},
        {CellId_t("cell-2"): {"disabled": False}},
    ]


def test_sync_does_not_notify_kernel_when_configs_are_unchanged() -> None:
    session, queue_manager = _make_session()
    session._notebook_uri = "file:///test.py"
    config = Mock(asdict=Mock(return_value={"disabled": True}))
    session._app_file_manager = Mock()
    session._app_file_manager.app.cell_manager.config_map.side_effect = [
        {CellId_t("cell-1"): config},
        {CellId_t("cell-1"): config},
    ]

    session.sync(Mock())

    queue_manager.control_queue.put.assert_not_called()


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
    session._operation_sink = _OperationSink(Mock(), "file:///test.py", SESSION_ID)
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
    session._operation_sink = _OperationSink(Mock(), "file:///test.py", SESSION_ID)
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


def test_saved_session_writer_outlives_client_attachment() -> None:
    session, _queue_manager = _make_session()
    session._config_manager = Mock()
    session._runtime_config = DEFAULT_CONFIG
    session._operation_sink = _OperationSink(Mock(), "file:///test.py", SESSION_ID)
    writer = Mock()
    session._saved_session_writer = writer

    session.detach()

    writer.stop.assert_not_called()

    session.attach()

    writer.start.assert_not_called()


def test_saved_session_writer_starts_only_after_session_activation() -> None:
    session, _queue_manager = _make_session()
    session._activated = False
    session._operation_sink = _OperationSink(
        Mock(),
        "file:///test.py",
        SESSION_ID,
        activated=False,
    )
    writer = Mock()
    session._saved_session_writer = writer

    session.activate()

    writer.start.assert_called_once_with()


def test_close_releases_kernel_after_event_loop_is_closed() -> None:
    session, _queue_manager = _make_session()
    session.session_id = SESSION_ID
    session._operation_sink = Mock()
    session._kernel = Mock()
    session._saved_session_location = Mock()
    session._saved_session_location.cancel.side_effect = RuntimeError(
        "Event loop is closed"
    )
    session._saved_session_writer = Mock()
    session._saved_session_writer.stop.side_effect = RuntimeError(
        "Event loop is closed"
    )
    loop = asyncio.new_event_loop()
    session._idle = asyncio.Event()
    waiter = loop.create_task(session._idle.wait())
    loop.run_until_complete(asyncio.sleep(0))
    loop.close()

    try:
        session.close()
        session.close()
    finally:
        coroutine = waiter.get_coro()
        assert coroutine is not None
        coroutine.close()
        waiter._log_destroy_pending = False  # ty: ignore[unresolved-attribute]

    session._kernel.close.assert_called_once_with()
    session._operation_sink.detach.assert_called_once_with()


@pytest.mark.asyncio
async def test_moving_a_session_relocates_its_writer() -> None:
    session, _queue_manager = _make_session()
    session._notebook_uri = "file:///old.py"
    session._kernel.marimo_version = "1.2.3"
    session._saved_session_files = Mock()
    session._operation_sink = _OperationSink(Mock(), "file:///old.py", SESSION_ID)
    app_file_manager = Mock()
    app_file_manager.path = "/workspace/old.py"
    app_file_manager.header = None
    app_file_manager.app.cell_manager.cell_ids.return_value = []

    def move(_notebook_uri: str) -> None:
        app_file_manager.path = "/workspace/renamed.py"

    app_file_manager.move.side_effect = move
    session._app_file_manager = app_file_manager
    kernel = Mock()
    kernel.marimo_version = "1.2.3"
    kernel.locate_saved_session = AsyncMock(
        return_value="/workspace/__marimo__/session/renamed.py.json"
    )
    session._kernel = cast("Kernel", kernel)
    old_writer = Mock()
    old_writer.stop.return_value = False
    session._saved_session_writer = old_writer
    session.session_view.mark_auto_export_session()

    session.move("file:///renamed.py")
    assert session._saved_session_location is not None
    await session._saved_session_location

    old_writer.stop.assert_called_once_with()
    kernel.locate_saved_session.assert_awaited_once_with("/workspace/renamed.py")
    assert session._saved_session_writer is not None
    assert (
        session._saved_session_writer._target
        == "/workspace/__marimo__/session/renamed.py.json"
    )
    assert session._saved_session_writer.running
    session._saved_session_writer.stop()


@pytest.mark.asyncio
async def test_rapid_moves_preserve_an_in_flight_write_retry() -> None:
    session, _queue_manager = _make_session()
    session._notebook_uri = "file:///old.py"
    session._activated = False
    session._saved_session_files = Mock()
    session._operation_sink = _OperationSink(Mock(), "file:///old.py", SESSION_ID)
    app_file_manager = Mock()
    app_file_manager.path = "/workspace/old.py"
    app_file_manager.header = None
    app_file_manager.app.cell_manager.cell_ids.return_value = []

    def move(notebook_uri: str) -> None:
        app_file_manager.path = {
            "file:///first.py": "/workspace/first.py",
            "file:///second.py": "/workspace/second.py",
        }[notebook_uri]

    app_file_manager.move.side_effect = move
    session._app_file_manager = app_file_manager
    first_started = asyncio.Event()

    async def locate(path: str) -> str:
        if path == "/workspace/first.py":
            first_started.set()
            await asyncio.Event().wait()
        return "/workspace/__marimo__/session/second.py.json"

    kernel = Mock()
    kernel.marimo_version = "1.2.3"
    kernel.locate_saved_session = AsyncMock(side_effect=locate)
    session._kernel = cast("Kernel", kernel)
    old_writer = Mock()
    old_writer.stop.return_value = True
    session._saved_session_writer = old_writer

    session.move("file:///first.py")
    await first_started.wait()
    session.move("file:///second.py")
    assert session._saved_session_location is not None
    await session._saved_session_location

    assert session._saved_session_writer is not None
    assert session._saved_session_writer._pending
    session._saved_session_writer.stop()


def test_detached_operation_sink_drops_messages_until_reattached() -> None:
    server = Mock()
    sink = _OperationSink(server, "file:///test.py", SESSION_ID)
    message = KernelMessage(b'{"op": "completed-run", "run_id": null}')

    sink.detach()
    sink.notify(message)

    server.protocol.notify.assert_not_called()

    sink.attach()
    sink.notify(message)

    server.protocol.notify.assert_called_once_with(
        "marimo/kernelNotification",
        {
            "notebookUri": "file:///test.py",
            "sessionId": SESSION_ID,
            "notification": {"op": "completed-run", "run_id": None},
        },
    )


def test_operation_sink_buffers_until_session_is_activated() -> None:
    server = Mock()
    sink = _OperationSink(server, "file:///test.py", SESSION_ID, activated=False)
    message = KernelMessage(b'{"op": "completed-run", "run_id": null}')

    sink.notify(message)
    server.protocol.notify.assert_not_called()

    sink.activate()

    server.protocol.notify.assert_called_once_with(
        "marimo/kernelNotification",
        {
            "notebookUri": "file:///test.py",
            "sessionId": SESSION_ID,
            "notification": {"op": "completed-run", "run_id": None},
        },
    )


def test_session_status_tracks_running_and_completed_operations() -> None:
    session, _ = _make_session()

    session._update_status(KernelMessage(b'{"op": "cell-op", "status": "running"}'))
    assert session._status == "running"

    session._update_status(KernelMessage(b'{"op": "completed-run"}'))
    assert session._status == "idle"
    assert session._on_change.call_count == 2


@pytest.mark.asyncio
async def test_wait_until_idle_blocks_while_an_execution_is_running() -> None:
    session, _ = _make_session()
    session.mark_running()

    waiter = asyncio.create_task(session.wait_until_idle())
    await asyncio.sleep(0)
    assert not waiter.done()

    session._update_status(KernelMessage(b'{"op": "completed-run"}'))
    assert await waiter


def test_scratchpad_ignores_unrelated_completed_runs() -> None:
    session, _ = _make_session()

    assert session.try_start_scratchpad("scratch-1")
    session._update_status(KernelMessage(b'{"op": "completed-run", "run_id": null}'))

    assert session._status == "running"
    assert session.is_scratchpad_running("scratch-1")

    session._update_status(
        KernelMessage(b'{"op": "completed-run", "run_id": "scratch-1"}')
    )
    assert session._status == "idle"
    assert not session.is_scratchpad_running("scratch-1")


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


def test_pending_scratchpad_cancellation_does_not_interrupt_other_work() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    session = Mock(spec=Session)
    sessions._sessions["file:///test.py"] = session
    session.is_scratchpad_running.return_value = False

    sessions.cancel_scratchpad("file:///test.py", "run-1")

    session.try_interrupt.assert_not_called()
    assert sessions.take_scratchpad_cancellation("file:///test.py", "run-1")
    assert not sessions.take_scratchpad_cancellation("file:///test.py", "run-1")


def test_active_scratchpad_cancellation_interrupts_and_is_consumed_once() -> None:
    sessions = Sessions(Mock(), kernels=Mock())
    session = Mock(spec=Session)
    sessions._sessions["file:///test.py"] = session
    session.is_scratchpad_running.return_value = True

    sessions.cancel_scratchpad("file:///test.py", "run-1")

    session.try_interrupt.assert_called_once_with()
    assert sessions.take_scratchpad_cancellation("file:///test.py", "run-1")
    assert not sessions.take_scratchpad_cancellation("file:///test.py", "run-1")


def test_sessions_changed_notification_contains_public_snapshot() -> None:
    server = Mock()
    sessions = Sessions(server, kernels=Mock())
    session = Mock(spec=Session)
    session.describe.return_value = SessionInfo(
        session_id=SESSION_ID,
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
                    "sessionId": SESSION_ID,
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
    events: list[str] = []
    sessions = Sessions(Mock(), kernels=Mock())
    current = Mock(spec=Session)
    current.executable = "/old/python"
    current.close.side_effect = lambda: events.append("old closed")
    replacement = Mock(spec=Session)
    replacement.describe.return_value = Mock()
    replacement.activate.side_effect = lambda: events.append("new activated")
    sessions._sessions["file:///test.py"] = current
    sessions._create = AsyncMock(return_value=replacement)
    sessions._notify_changed = Mock(
        side_effect=lambda: events.append("snapshot published")
    )

    result = await sessions.start("file:///test.py", "/new/python", "/workspace")

    assert result is replacement
    assert sessions.get("file:///test.py") is replacement
    current.close.assert_called_once_with()
    sessions._notify_changed.assert_called_once_with()
    replacement.activate.assert_called_once_with()
    assert events == ["old closed", "snapshot published", "new activated"]


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
    kernel.marimo_version = "1.2.3-rc1+build.7"
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
    previous.marimo_version = "1.2.3-rc1+build.7"
    loop_thread = threading.get_ident()
    observed: list[tuple[KernelMessage, int]] = []
    third_delivered = asyncio.Event()

    def accept(_session: Session, message: KernelMessage) -> None:
        observed.append((message, threading.get_ident()))
        if message == third:
            third_delivered.set()

    monkeypatch.setattr(Session, "accept_kernel_message", accept)

    created = await sessions._create(
        "file:///test.py",
        "/usr/bin/python",
        "/workspace",
        previous=previous,
    )
    assert created.marimo_version == "1.2.3-rc1+build.7"
    assert created.session_view is previous.session_view
    threading.Thread(target=receive_callback[0], args=(third,), daemon=True).start()
    await asyncio.wait_for(third_delivered.wait(), timeout=1)

    assert observed == [
        (first, loop_thread),
        (second, loop_thread),
        (third, loop_thread),
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("previous_version", "kernel_version"),
    [
        ("1.2.3", "1.2.4"),
        (None, None),
        (None, "1.2.4"),
        ("1.2.3", None),
        ("unknown", "unknown"),
    ],
)
async def test_session_creation_drops_view_without_known_matching_versions(
    previous_version: str | None,
    kernel_version: str | None,
) -> None:
    kernel = Mock()
    kernel.marimo_version = kernel_version
    kernels = Mock()
    kernels.launch = AsyncMock(return_value=kernel)
    sessions = Sessions(Mock(), kernels=kernels)
    previous = Mock(spec=Session)
    previous.app_file_manager = Mock()
    previous.config_manager = Mock()
    previous.config_manager.get_config.return_value = DEFAULT_CONFIG
    previous.session_view = SessionView()
    previous.started_at = 42
    previous.marimo_version = previous_version

    created = await sessions._create(
        "file:///test.py",
        "/usr/bin/python",
        "/workspace",
        previous=previous,
    )

    assert created.marimo_version == (
        None if kernel_version == "unknown" else kernel_version
    )
    assert created.session_view is not previous.session_view


@pytest.mark.asyncio
async def test_session_creation_binds_the_selected_kernel_cache_path() -> None:
    kernel = Mock()
    kernel.marimo_version = "1.2.3"
    kernel.locate_saved_session = AsyncMock(
        return_value="/workspace/__marimo__/session/notebook.py.json"
    )
    kernels = Mock()
    kernels.launch = AsyncMock(return_value=kernel)
    sessions = Sessions(Mock(), kernels=kernels)
    previous = Mock(spec=Session)
    previous.app_file_manager = Mock()
    previous.app_file_manager.path = "/workspace/notebook.py"
    previous.config_manager = Mock()
    previous.config_manager.get_config.return_value = DEFAULT_CONFIG
    previous.session_view = SessionView()
    previous.started_at = 42
    previous.marimo_version = "1.2.3"

    created = await sessions._create(
        "file:///workspace/notebook.py",
        "/usr/bin/python",
        "/workspace",
        previous=previous,
    )

    kernel.locate_saved_session.assert_awaited_once_with("/workspace/notebook.py")
    assert created._saved_session_writer is not None
    assert (
        created._saved_session_writer._target
        == "/workspace/__marimo__/session/notebook.py.json"
    )
    created.close()


@pytest.mark.asyncio
async def test_session_creation_restores_the_selected_kernel_cache_before_writing(
    tmp_path: Path,
) -> None:
    cell_id = CellId_t("cell")
    restored = SessionView()
    restored.add_control_request(
        ExecuteCellsCommand(cell_ids=[cell_id], codes=["value = 1"])
    )
    restored.add_notification(
        CellNotification(
            cell_id=cell_id,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data="saved",
            ),
            console=[],
            timestamp=1,
        )
    )
    snapshot = serialize_saved_session_view(
        restored,
        cell_ids=[cell_id],
        marimo_version="1.2.4",
        header=None,
    )
    assert snapshot is not None
    files = Mock()
    files.read = AsyncMock(return_value=json.dumps(snapshot))
    files.replace = AsyncMock()
    kernel = Mock()
    kernel.marimo_version = "1.2.4"
    kernel.locate_saved_session = AsyncMock(return_value=str(tmp_path / "session.json"))
    kernels = Mock()
    kernels.launch = AsyncMock(return_value=kernel)
    sessions = Sessions(Mock(), kernels=kernels, saved_session_files=files)
    previous = Mock(spec=Session)
    previous.app_file_manager = Mock()
    previous.app_file_manager.path = str(tmp_path / "notebook.py")
    previous.app_file_manager.header = None
    previous.app_file_manager.app.cell_manager.codes.return_value = ["value = 1"]
    previous.app_file_manager.app.cell_manager.cell_ids.return_value = [cell_id]
    previous.app_file_manager.app.cell_manager.code_map.return_value = {
        cell_id: "value = 1"
    }
    previous.config_manager = Mock()
    previous.config_manager.get_config.return_value = DEFAULT_CONFIG
    previous.session_view = SessionView()
    previous.started_at = 42
    previous.marimo_version = "1.2.3"

    created = await sessions._create(
        "file:///workspace/notebook.py",
        "/usr/bin/python",
        "/workspace",
        previous=previous,
    )

    notification = created.session_view.cell_notifications[cell_id]
    assert notification.output is not None
    assert notification.output.data == "saved"
    assert not created.session_view.needs_export("session")
    files.read.assert_awaited_once_with(str(tmp_path / "session.json"))

    created.detach()
    writer = created._saved_session_writer
    assert writer is not None
    assert not await writer.flush_once()
    files.replace.assert_not_awaited()

    created.instantiate(
        InstantiateNotebookRequest(auto_run=False, object_ids=[], values=[]),
        http_request=None,
    )
    assert await writer.flush_once()
    replace_args = files.replace.await_args
    assert replace_args is not None
    written = replace_args.args[1]
    assert (
        decode_saved_session_view(
            written,
            codes=("value = 1",),
            cell_ids=(cell_id,),
            marimo_version="1.2.4",
            header=None,
        )
        is not None
    )
    created.close()


@pytest.mark.asyncio
async def test_fresh_session_does_not_write_until_the_view_changes(
    tmp_path: Path,
) -> None:
    files = Mock()
    files.read = AsyncMock(return_value=None)
    files.replace = AsyncMock()
    kernel = Mock()
    kernel.marimo_version = "1.2.3"
    kernel.locate_saved_session = AsyncMock(return_value=str(tmp_path / "session.json"))
    kernels = Mock()
    kernels.launch = AsyncMock(return_value=kernel)
    server = Mock()
    app_file_manager = Mock()
    app_file_manager.path = str(tmp_path / "notebook.py")
    app_file_manager.header = None
    app_file_manager.app.cell_manager.codes.return_value = []
    app_file_manager.app.cell_manager.cell_ids.return_value = []
    with pytest.MonkeyPatch.context() as monkeypatch:
        monkeypatch.setattr(
            "marimo_lsp.sessions.LspAppFileManager",
            Mock(return_value=app_file_manager),
        )
        sessions = Sessions(server, kernels=kernels, saved_session_files=files)
        created = await sessions._create(
            "file:///workspace/notebook.py",
            "/usr/bin/python",
            "/workspace",
        )

    writer = created._saved_session_writer
    assert writer is not None
    assert not await writer.flush_once()

    created.put_control_request(
        ExecuteCellsCommand(cell_ids=[], codes=[]),
        from_consumer_id=None,
    )

    assert await writer.flush_once()
    files.replace.assert_awaited_once()
    created.close()


@pytest.mark.asyncio
async def test_terminal_error_during_startup_handoff_aborts_session() -> None:
    error = KernelMessage(b'{"op": "kernel-startup-error", "error": "bridge exited"}')
    kernel = Mock()

    async def launch(**kwargs: object) -> object:
        receive = cast("Callable[[KernelMessage], None]", kwargs["receive"])
        receive(error)
        await asyncio.sleep(0)
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

    with pytest.raises(KernelOpenError, match="bridge exited"):
        await sessions._create(
            "file:///test.py",
            "/usr/bin/python",
            "/workspace",
            previous=previous,
        )

    kernel.close.assert_called_once_with()


@pytest.mark.asyncio
async def test_restart_replaces_kernel_without_reloading_closed_notebook() -> None:
    events: list[str] = []
    sessions = Sessions(Mock(), kernels=Mock())
    current = Mock(spec=Session)
    current.executable = "/usr/bin/python"
    current.working_directory = "/workspace"
    current.attached = False
    current.session_view = Mock()
    current.started_at = 42
    current.close.side_effect = lambda: events.append("old closed")
    replacement = Mock(spec=Session)
    replacement.activate.side_effect = lambda: events.append("new activated")
    sessions._sessions["file:///test.py"] = current
    sessions._create = AsyncMock(return_value=replacement)
    sessions._notify_changed = Mock(
        side_effect=lambda: events.append("snapshot published")
    )

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
    replacement.activate.assert_called_once_with()
    assert events == ["old closed", "snapshot published", "new activated"]


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
