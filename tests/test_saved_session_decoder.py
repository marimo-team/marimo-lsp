# Copyright 2026 Marimo. All rights reserved.

"""Tests for the marimo-compatible saved-session decoder."""

from __future__ import annotations

import json

import pytest
from marimo import __version__
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.errors import MarimoExceptionRaisedError
from marimo._messaging.notification import CellNotification
from marimo._session.state.serialize import serialize_session_view
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t
from marimo._utils.code import hash_code
from marimo._utils.inline_script_metadata import read_pyproject_from_script

from marimo_lsp import saved_sessions
from marimo_lsp.saved_sessions import decode_saved_session_view

SAVED_ID = CellId_t("saved")
CURRENT_ID = CellId_t("current")
SECOND_CURRENT_ID = CellId_t("current-2")
CODE = "answer = 42\nanswer"
SECOND_CODE = "other = 7\nother"
HEADER = """# /// script
# dependencies = [\"polars\"]
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


SCRIPT_METADATA_HASH = _script_metadata_hash(HEADER)


def _saved_session_contents() -> str:
    view = SessionView()
    view.cell_notifications[SAVED_ID] = CellNotification(
        cell_id=SAVED_ID,
        status="idle",
        output=CellOutput(
            channel=CellChannel.OUTPUT,
            mimetype="text/html",
            data="<strong>42</strong>",
        ),
        console=[
            CellOutput(
                channel=CellChannel.STDOUT,
                mimetype="text/plain",
                data="ready\n",
            )
        ],
    )
    view.last_executed_code[SAVED_ID] = CODE
    saved = serialize_session_view(
        view,
        cell_ids=[SAVED_ID],
        drop_virtual_file_outputs=True,
        script_metadata_hash=SCRIPT_METADATA_HASH,
    )
    return json.dumps(saved)


def _decode(
    contents: str | None = None,
    *,
    version: str | None = __version__,
):
    return decode_saved_session_view(
        contents if contents is not None else _saved_session_contents(),
        codes=(CODE,),
        cell_ids=(CURRENT_ID,),
        marimo_version=version,
        header=HEADER,
    )


def test_decodes_compatible_outputs_by_code_hash() -> None:
    restored = _decode()

    assert restored is not None
    assert set(restored.cell_notifications) == {CURRENT_ID}
    notification = restored.cell_notifications[CURRENT_ID]
    assert notification.status == "idle"
    assert notification.timestamp == 0
    assert notification.output is not None
    assert notification.output.channel == CellChannel.OUTPUT
    assert notification.output.mimetype == "text/html"
    assert notification.output.data == "<strong>42</strong>"
    assert isinstance(notification.console, list)
    [console] = notification.console
    assert isinstance(console, CellOutput)
    assert console.channel == CellChannel.STDOUT
    assert console.data == "ready\n"
    assert restored.last_executed_code == {}


@pytest.mark.parametrize("traceback", [None, "<span>traceback</span>"])
def test_decodes_exception_outputs_written_by_marimo(
    traceback: str | None,
) -> None:
    view = SessionView()
    view.cell_notifications[SAVED_ID] = CellNotification(
        cell_id=SAVED_ID,
        status="idle",
        output=CellOutput.errors(
            [
                MarimoExceptionRaisedError(
                    msg="bad value",
                    exception_type="ValueError",
                    raising_cell=None,
                    traceback=traceback,
                )
            ]
        ),
    )
    view.last_executed_code[SAVED_ID] = CODE
    saved = serialize_session_view(
        view,
        cell_ids=[SAVED_ID],
        drop_virtual_file_outputs=True,
        script_metadata_hash=SCRIPT_METADATA_HASH,
    )

    restored = _decode(json.dumps(saved))

    assert restored is not None
    output = restored.cell_notifications[CURRENT_ID].output
    assert output is not None
    assert output.channel == CellChannel.MARIMO_ERROR


@pytest.mark.parametrize(
    "data",
    [{"value": float("nan")}, "\ud800"],
    ids=["non-finite-number", "escaped-lone-surrogate"],
)
def test_decodes_mime_data_written_by_marimo(
    data: str | dict[str, float],
) -> None:
    view = SessionView()
    view.cell_notifications[SAVED_ID] = CellNotification(
        cell_id=SAVED_ID,
        status="idle",
        output=CellOutput(
            channel=CellChannel.OUTPUT,
            mimetype="application/json",
            data=data,
        ),
    )
    view.last_executed_code[SAVED_ID] = CODE
    saved = serialize_session_view(
        view,
        cell_ids=[SAVED_ID],
        drop_virtual_file_outputs=True,
        script_metadata_hash=SCRIPT_METADATA_HASH,
    )

    restored = _decode(json.dumps(saved))

    assert restored is not None
    assert restored.cell_notifications[CURRENT_ID].output is not None


@pytest.mark.parametrize(
    ("codes", "cell_ids", "version"),
    [
        (("changed",), (CURRENT_ID,), __version__),
        ((CODE,), (CURRENT_ID,), "0.0.0"),
        ((CODE,), (), __version__),
    ],
    ids=["code", "version", "unaligned-key"],
)
def test_rejects_incompatible_cache_keys(
    codes: tuple[str, ...],
    cell_ids: tuple[CellId_t, ...],
    version: str,
) -> None:
    assert (
        decode_saved_session_view(
            _saved_session_contents(),
            codes=codes,
            cell_ids=cell_ids,
            marimo_version=version,
            header=HEADER,
        )
        is None
    )


def test_rejects_changed_script_metadata() -> None:
    assert (
        decode_saved_session_view(
            _saved_session_contents(),
            codes=(CODE,),
            cell_ids=(CURRENT_ID,),
            marimo_version=__version__,
            header=HEADER.replace("polars", "pandas"),
        )
        is None
    )


def test_accepts_notebook_without_script_metadata() -> None:
    payload = json.loads(_saved_session_contents())
    payload["metadata"]["script_metadata_hash"] = None

    assert (
        decode_saved_session_view(
            json.dumps(payload),
            codes=(CODE,),
            cell_ids=(CURRENT_ID,),
            marimo_version=__version__,
            header=None,
        )
        is not None
    )


def test_malformed_script_metadata_matches_marimo_missing_hash_semantics() -> None:
    payload = json.loads(_saved_session_contents())
    payload["metadata"]["script_metadata_hash"] = None
    malformed_header = HEADER + HEADER

    assert (
        decode_saved_session_view(
            json.dumps(payload),
            codes=(CODE,),
            cell_ids=(CURRENT_ID,),
            marimo_version=__version__,
            header=malformed_header,
        )
        is not None
    )


def test_unknown_kernel_version_fails_closed() -> None:
    assert _decode(version=None) is None


def test_accepts_v1_cache_from_matching_foreign_kernel_version() -> None:
    payload = json.loads(_saved_session_contents())
    payload["metadata"]["marimo_version"] = "0.23.3"

    assert _decode(json.dumps(payload), version="0.23.3") is not None


@pytest.mark.parametrize("wire_version", [None, "999"])
def test_rejects_missing_or_unsupported_wire_version(
    wire_version: str | None,
) -> None:
    payload = json.loads(_saved_session_contents())
    if wire_version is None:
        del payload["version"]
    else:
        payload["version"] = wire_version

    assert _decode(json.dumps(payload)) is None


def test_duplicate_code_hashes_fail_closed() -> None:
    payload = json.loads(_saved_session_contents())
    duplicate = json.loads(json.dumps(payload["cells"][0]))
    duplicate["id"] = "saved-2"
    duplicate["outputs"][0]["data"]["text/html"] = "<strong>second</strong>"
    payload["cells"].append(duplicate)

    assert (
        decode_saved_session_view(
            json.dumps(payload),
            codes=(CODE, CODE),
            cell_ids=(CURRENT_ID, SECOND_CURRENT_ID),
            marimo_version=__version__,
            header=HEADER,
        )
        is None
    )


def test_duplicate_current_cell_ids_fail_closed() -> None:
    payload = json.loads(_saved_session_contents())
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


def test_invalid_json_fails_closed() -> None:
    assert _decode("not json") is None


def test_invalid_cell_shape_fails_closed() -> None:
    payload = json.loads(_saved_session_contents())
    payload["cells"][0] = None

    assert _decode(json.dumps(payload)) is None


def test_unknown_output_type_fails_closed() -> None:
    payload = json.loads(_saved_session_contents())
    payload["cells"][0]["outputs"][0]["type"] = "future"

    assert _decode(json.dumps(payload)) is None


def test_invalid_console_name_fails_closed() -> None:
    payload = json.loads(_saved_session_contents())
    payload["cells"][0]["console"][0]["name"] = "stdin"

    assert _decode(json.dumps(payload)) is None


def test_oversized_contents_fail_closed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(saved_sessions, "_MAX_SAVED_SESSION_BYTES", 8)

    assert _decode(" " * 9) is None


def test_oversized_character_count_returns_before_encoding(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class MustNotEncode(str):
        __slots__ = ()

        def encode(
            self,
            encoding: str = "utf-8",
            errors: str = "strict",
        ) -> bytes:
            del encoding, errors
            raise AssertionError

    monkeypatch.setattr(saved_sessions, "_MAX_SAVED_SESSION_BYTES", 8)

    assert _decode(MustNotEncode(" " * 9)) is None
