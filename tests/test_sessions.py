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
from marimo._types.ids import CellId_t, RequestId, UIElementId

from marimo_lsp.sessions import Session, Sessions, _OperationSink


def _make_session() -> tuple[Session, Mock]:
    session = Session.__new__(Session)
    ipc_queue_manager = Mock()
    session._queue_manager = IPCQueueManagerImpl.from_ipc(ipc_queue_manager)
    return session, ipc_queue_manager


def test_ui_element_updates_use_marimo_ipc_batching_route() -> None:
    session, queue_manager = _make_session()
    command = UpdateUIElementCommand(object_ids=[UIElementId("slider")], values=[1])

    session.put_control_request(command, from_consumer_id=None)

    queue_manager.control_queue.put.assert_called_once_with(command)
    queue_manager.set_ui_element_queue.put.assert_called_once_with(command)
    queue_manager.completion_queue.put.assert_not_called()


def test_regular_commands_are_routed_to_control_queue_only() -> None:
    session, queue_manager = _make_session()
    command = StopKernelCommand()

    session.put_control_request(command, from_consumer_id=None)

    queue_manager.control_queue.put.assert_called_once_with(command)
    queue_manager.set_ui_element_queue.put.assert_not_called()
    queue_manager.completion_queue.put.assert_not_called()


def test_out_of_band_commands_are_routed_to_completion_queue() -> None:
    session, queue_manager = _make_session()
    command = CodeCompletionCommand(
        id=RequestId("request"), document="mo.", cell_id=CellId_t("cell")
    )

    session.put_control_request(command, from_consumer_id=None)

    queue_manager.completion_queue.put.assert_called_once_with(command)
    queue_manager.control_queue.put.assert_not_called()
    queue_manager.set_ui_element_queue.put.assert_not_called()


def test_detach_pauses_and_attach_restores_auto_reload() -> None:
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

    session.detach()

    paused = queue_manager.control_queue.put.call_args_list[0].args[0]
    assert isinstance(paused, UpdateUserConfigCommand)
    paused_runtime = cast("RuntimeConfig", paused.config.get("runtime", {}))
    configured_runtime = cast("RuntimeConfig", configured.get("runtime", {}))
    assert paused_runtime.get("auto_reload") == "off"
    assert configured_runtime.get("auto_reload") == "autorun"
    assert not session.attached

    session.attach()

    restored = queue_manager.control_queue.put.call_args_list[1].args[0]
    assert isinstance(restored, UpdateUserConfigCommand)
    restored_runtime = cast("RuntimeConfig", restored.config.get("runtime", {}))
    assert restored_runtime.get("auto_reload") == "autorun"
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
