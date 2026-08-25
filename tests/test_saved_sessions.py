# Copyright 2026 Marimo. All rights reserved.

"""Characterize marimo's saved-session format at the LSP boundary."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest
from marimo import __version__
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._runtime.commands import ExecuteCellsCommand
from marimo._session.state.serialize import (
    get_session_cache_file,
    serialize_session_view,
)
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t
from marimo._utils.code import hash_code
from marimo._utils.inline_script_metadata import read_pyproject_from_script

from marimo_lsp.saved_sessions import (
    decode_saved_session_view,
    serialize_saved_session_view,
)

SAVED_ID = CellId_t("saved")
CURRENT_ID = CellId_t("current")
SECOND_ID = CellId_t("second")
CODE = "answer = 42\nanswer"
SECOND_CODE = "other = 7\nother"
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


def _view(*, code: str = CODE, output: str = "42") -> SessionView:
    view = SessionView()
    view.add_control_request(ExecuteCellsCommand(cell_ids=[SAVED_ID], codes=[code]))
    view.add_notification(
        CellNotification(
            cell_id=SAVED_ID,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data=output,
            ),
            console=[
                CellOutput(
                    channel=CellChannel.STDOUT,
                    mimetype="text/plain",
                    data="ready\n",
                )
            ],
            timestamp=12.5,
        )
    )
    return view


def _contents(*, marimo_version: str = __version__) -> str:
    snapshot = serialize_session_view(
        _view(),
        cell_ids=[SAVED_ID],
        drop_virtual_file_outputs=True,
        script_metadata_hash=_script_metadata_hash(HEADER),
    )
    snapshot["metadata"]["marimo_version"] = marimo_version
    return json.dumps(snapshot)


def _decode(contents: str | None = None, *, version: str | None = __version__):
    return decode_saved_session_view(
        contents if contents is not None else _contents(),
        codes=(CODE,),
        cell_ids=(CURRENT_ID,),
        marimo_version=version,
        header=HEADER,
    )


def test_upstream_cache_path_is_beside_the_notebook(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    notebook = tmp_path / "notebook.py"
    monkeypatch.setattr(sys, "pycache_prefix", None)

    assert get_session_cache_file(notebook) == (
        tmp_path / "__marimo__" / "session" / "notebook.py.json"
    )


def test_upstream_cache_path_follows_pycache_prefix(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    notebook = tmp_path / "workspace" / "notebook.py"
    prefix = tmp_path / "cache"
    monkeypatch.setattr(sys, "pycache_prefix", str(prefix))

    assert get_session_cache_file(notebook) == (
        prefix
        / Path(*notebook.parent.parts[1:])
        / "__marimo__"
        / "session"
        / "notebook.py.json"
    )


def test_serializes_upstream_v1_with_selected_kernel_version() -> None:
    snapshot = serialize_saved_session_view(
        _view(),
        cell_ids=[SAVED_ID],
        marimo_version="1.2.3-rc1+build.7",
        header=HEADER,
    )

    assert snapshot is not None
    assert snapshot["version"] == "1"
    assert snapshot["metadata"] == {
        "marimo_version": "1.2.3-rc1+build.7",
        "script_metadata_hash": _script_metadata_hash(HEADER),
    }
    assert snapshot["cells"][0]["code_hash"] == hash_code(CODE)
    assert snapshot["cells"][0]["outputs"] == [
        {"type": "data", "data": {"text/plain": "42"}}
    ]


@pytest.mark.parametrize("version", [None, "unknown"])
def test_unknown_kernel_version_does_not_serialize_or_decode(
    version: str | None,
) -> None:
    assert (
        serialize_saved_session_view(
            _view(),
            cell_ids=[SAVED_ID],
            marimo_version=version,
            header=None,
        )
        is None
    )
    assert _decode(version=version) is None


def test_decodes_compatible_outputs_by_code_hash() -> None:
    restored = _decode()

    assert restored is not None
    assert set(restored.cell_notifications) == {CURRENT_ID}
    notification = restored.cell_notifications[CURRENT_ID]
    assert notification.status == "idle"
    assert notification.timestamp == 0
    assert notification.output is not None
    assert notification.output.data == "42"
    assert isinstance(notification.console, list)
    [console] = notification.console
    assert isinstance(console, CellOutput)
    assert console.channel == CellChannel.STDOUT
    assert console.data == "ready\n"
    assert restored.last_executed_code == {}


def test_upstream_reader_skips_future_output_types() -> None:
    payload = json.loads(_contents())
    payload["cells"][0]["outputs"].insert(
        0,
        {"type": "future-output", "data": "opaque"},
    )

    restored = _decode(json.dumps(payload))

    assert restored is not None
    output = restored.cell_notifications[CURRENT_ID].output
    assert output is not None
    assert output.data == "42"


@pytest.mark.parametrize(
    ("codes", "cell_ids", "version", "header"),
    [
        (("changed",), (CURRENT_ID,), __version__, HEADER),
        ((CODE,), (CURRENT_ID,), "0.0.0", HEADER),
        ((CODE,), (), __version__, HEADER),
        ((CODE,), (CURRENT_ID,), __version__, HEADER.replace("polars", "pandas")),
    ],
    ids=["code", "version", "unaligned-key", "script-metadata"],
)
def test_rejects_incompatible_cache_keys(
    codes: tuple[str, ...],
    cell_ids: tuple[CellId_t, ...],
    version: str,
    header: str,
) -> None:
    assert (
        decode_saved_session_view(
            _contents(),
            codes=codes,
            cell_ids=cell_ids,
            marimo_version=version,
            header=header,
        )
        is None
    )


def test_duplicate_code_hashes_fail_closed() -> None:
    payload = json.loads(_contents())
    duplicate = json.loads(json.dumps(payload["cells"][0]))
    duplicate["id"] = "saved-2"
    duplicate["outputs"][0]["data"]["text/plain"] = "second"
    payload["cells"].append(duplicate)

    assert (
        decode_saved_session_view(
            json.dumps(payload),
            codes=(CODE, CODE),
            cell_ids=(CURRENT_ID, SECOND_ID),
            marimo_version=__version__,
            header=HEADER,
        )
        is None
    )


def test_duplicate_current_cell_ids_fail_closed() -> None:
    payload = json.loads(_contents())
    second = json.loads(json.dumps(payload["cells"][0]))
    second["id"] = "saved-2"
    second["code_hash"] = hash_code(SECOND_CODE)
    payload["cells"].append(second)

    assert (
        decode_saved_session_view(
            json.dumps(payload),
            codes=(CODE, SECOND_CODE),
            cell_ids=(CURRENT_ID, CURRENT_ID),
            marimo_version=__version__,
            header=HEADER,
        )
        is None
    )


def test_requested_code_can_keep_the_previous_display() -> None:
    view = _view(code="old_code", output="old output")
    view.add_control_request(
        ExecuteCellsCommand(cell_ids=[SAVED_ID], codes=["new_code"])
    )
    snapshot = serialize_saved_session_view(
        view,
        cell_ids=[SAVED_ID],
        marimo_version=__version__,
        header=None,
    )
    assert snapshot is not None

    restored = decode_saved_session_view(
        json.dumps(snapshot),
        codes=("new_code",),
        cell_ids=(CURRENT_ID,),
        marimo_version=__version__,
        header=None,
    )

    assert restored is not None
    output = restored.cell_notifications[CURRENT_ID].output
    assert output is not None
    assert output.data == "old output"


@pytest.mark.parametrize("contents", ["not json", "{}"])
def test_malformed_contents_fail_closed(contents: str) -> None:
    assert _decode(contents) is None
