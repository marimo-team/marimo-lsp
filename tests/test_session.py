# Copyright 2026 Marimo. All rights reserved.

"""Tests for the LSP session."""

from __future__ import annotations

from unittest.mock import Mock

from marimo._runtime.commands import (
    CodeCompletionCommand,
    StopKernelCommand,
    UpdateUIElementCommand,
)
from marimo._session.managers import IPCQueueManagerImpl
from marimo._types.ids import CellId_t, RequestId, UIElementId

from marimo_lsp.session import LspSession


def _make_session() -> tuple[LspSession, Mock]:
    session = LspSession.__new__(LspSession)
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
