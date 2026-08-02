# Copyright 2026 Marimo. All rights reserved.

"""Tests for live kernel sessions."""

from __future__ import annotations

import copy
from typing import cast
from unittest.mock import Mock

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

from marimo_lsp.sessions import Session, Sessions, _OperationSink


def _make_session() -> tuple[Session, Mock]:
    session = Session.__new__(Session)
    ipc_queue_manager = Mock()
    session._queue_manager = IPCQueueManagerImpl.from_ipc(ipc_queue_manager)
    session.session_view = SessionView()
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


def test_failed_kernel_start_closes_replacement_resources() -> None:
    queue_manager = Mock()
    kernel_manager = Mock()
    kernel_manager.kernel_task = Mock()
    kernel_manager.start_kernel.side_effect = RuntimeError("failed to start")
    config_manager = Mock()
    config_manager.get_config.return_value = DEFAULT_CONFIG

    with pytest.raises(RuntimeError, match="failed to start"):
        Session(
            initialization_id="session",
            notebook_uri="file:///test.py",
            operation_sink=Mock(),
            queue_manager=queue_manager,
            kernel_manager=kernel_manager,
            app_file_manager=Mock(),
            config_manager=config_manager,
        )

    kernel_manager.close_kernel.assert_called_once_with()
    queue_manager.close_queues.assert_called_once_with()


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


def test_start_reuses_session_with_same_executable() -> None:
    sessions = Sessions(Mock())
    current = Mock(spec=Session)
    current.executable = "/usr/bin/python"
    sessions._sessions["file:///test.py"] = current
    sessions._create = Mock()

    result = sessions.start("file:///test.py", "/usr/bin/python")

    assert result is current
    current.attach.assert_called_once_with()
    sessions._create.assert_not_called()


def test_start_reuses_same_executable_despite_new_working_directory() -> None:
    sessions = Sessions(Mock())
    current = Mock(spec=Session)
    current.executable = "/usr/bin/python"
    sessions._sessions["file:///test.py"] = current
    sessions._create = Mock()

    result = sessions.start(
        "file:///test.py", "/usr/bin/python", "/new/working/directory"
    )

    assert result is current
    current.attach.assert_called_once_with()
    sessions._create.assert_not_called()


def test_start_replaces_session_after_replacement_starts() -> None:
    sessions = Sessions(Mock())
    current = Mock(spec=Session)
    current.executable = "/old/python"
    replacement = Mock(spec=Session)
    sessions._sessions["file:///test.py"] = current
    sessions._create = Mock(return_value=replacement)

    result = sessions.start("file:///test.py", "/new/python")

    assert result is replacement
    assert sessions.get("file:///test.py") is replacement
    current.close.assert_called_once_with()


def test_failed_replacement_preserves_existing_session() -> None:
    sessions = Sessions(Mock())
    current = Mock(spec=Session)
    current.executable = "/old/python"
    sessions._sessions["file:///test.py"] = current
    sessions._create = Mock(side_effect=RuntimeError("failed to start"))

    with pytest.raises(RuntimeError, match="failed to start"):
        sessions.start("file:///test.py", "/new/python")

    assert sessions.get("file:///test.py") is current
    current.close.assert_not_called()
