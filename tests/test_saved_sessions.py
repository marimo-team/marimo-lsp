# Copyright 2026 Marimo. All rights reserved.

"""Behavior tests for cold saved-session decoding."""

from __future__ import annotations

import json

from marimo import __version__
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._runtime.commands import ExecuteCellsCommand
from marimo._session.state.serialize import serialize_session_view
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t
from marimo._utils.code import hash_code
from marimo._utils.inline_script_metadata import read_pyproject_from_script

from marimo_lsp.saved_sessions import decode_saved_session_outputs

SAVED_ID = CellId_t("saved")
CURRENT_ID = CellId_t("current")
CODE = "answer = 42\nanswer"
HEADER = """# /// script
# dependencies = ["polars"]
# ///
"""


def _script_metadata_hash(header: str) -> str:
    project = read_pyproject_from_script(header)
    assert project is not None
    return hash_code(
        json.dumps(
            project,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
    )


def _contents() -> str:
    view = SessionView()
    view.add_control_request(ExecuteCellsCommand(cell_ids=[SAVED_ID], codes=[CODE]))
    view.add_notification(
        CellNotification(
            cell_id=SAVED_ID,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data="42",
            ),
            console=[],
            timestamp=12.5,
        )
    )
    snapshot = serialize_session_view(
        view,
        cell_ids=[SAVED_ID],
        script_metadata_hash=_script_metadata_hash(HEADER),
        drop_virtual_file_outputs=True,
    )
    snapshot["metadata"]["marimo_version"] = __version__
    return json.dumps(snapshot)


def test_decodes_compatible_output_into_current_cell() -> None:
    notifications = decode_saved_session_outputs(
        _contents(),
        codes=[CODE],
        cell_ids=[CURRENT_ID],
        header=HEADER,
    )

    [notification] = notifications
    assert notification.cell_id == CURRENT_ID
    assert notification.status == "idle"
    assert notification.stale_inputs is True
    assert notification.output is not None
    assert notification.output.data == "42"


def test_ignores_output_for_changed_code() -> None:
    assert (
        decode_saved_session_outputs(
            _contents(),
            codes=["answer = 43\nanswer"],
            cell_ids=[CURRENT_ID],
            header=HEADER,
        )
        == []
    )


def test_ignores_output_for_changed_script_metadata() -> None:
    assert (
        decode_saved_session_outputs(
            _contents(),
            codes=[CODE],
            cell_ids=[CURRENT_ID],
            header=HEADER.replace("polars", "pandas"),
        )
        == []
    )


def test_ignores_malformed_snapshot() -> None:
    assert (
        decode_saved_session_outputs(
            "not json",
            codes=[CODE],
            cell_ids=[CURRENT_ID],
            header=HEADER,
        )
        == []
    )
