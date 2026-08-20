# Copyright 2026 Marimo. All rights reserved.

"""Tests for decoding saved outputs against the synchronized LSP document."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, cast
from unittest.mock import MagicMock, patch

import lsprotocol.types as lsp
import msgspec
import pytest
from marimo import __version__
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._session.state.serialize import serialize_session_view
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t
from marimo._utils.code import hash_code
from marimo._utils.inline_script_metadata import read_pyproject_from_script

from marimo_lsp.api import ApiContext, decode_saved_session, handle_api_command
from marimo_lsp.models import DecodeSavedSessionRequest, NotebookCommand

if TYPE_CHECKING:
    from collections.abc import Callable

NOTEBOOK_URI = "file:///workspace/notebook.py"
CELL_URI = f"{NOTEBOOK_URI}#cell"
SAVED_ID = CellId_t("saved")
CURRENT_ID = CellId_t("current")
CODE = "answer = 42\nanswer"
HEADER = """# /// script
# dependencies = ["polars"]
# ///
"""


def _metadata(value: dict[str, object]) -> lsp.LSPObject:
    return cast("lsp.LSPObject", value)


def _saved_contents() -> str:
    project = read_pyproject_from_script(HEADER)
    assert project is not None
    script_metadata_hash = hash_code(
        json.dumps(
            project,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
    )
    view = SessionView()
    view.cell_notifications[SAVED_ID] = CellNotification(
        cell_id=SAVED_ID,
        status="idle",
        output=CellOutput(
            channel=CellChannel.OUTPUT,
            mimetype="text/plain",
            data="42",
        ),
    )
    view.last_executed_code[SAVED_ID] = CODE
    return json.dumps(
        serialize_session_view(
            view,
            cell_ids=[SAVED_ID],
            drop_virtual_file_outputs=True,
            script_metadata_hash=script_metadata_hash,
        )
    )


def _context(*, code: str = CODE, header: str = HEADER) -> ApiContext:
    notebook = lsp.NotebookDocument(
        uri=NOTEBOOK_URI,
        notebook_type="marimo-notebook",
        version=1,
        cells=[
            lsp.NotebookCell(
                kind=lsp.NotebookCellKind.Code,
                document=CELL_URI,
                metadata=_metadata({"marimoRuntime": {"stableId": str(CURRENT_ID)}}),
            )
        ],
        metadata=_metadata({"marimo": {"header": header}}),
    )
    workspace = MagicMock()
    workspace.notebook_documents = {NOTEBOOK_URI: notebook}
    workspace.text_documents = {CELL_URI: MagicMock(source=code, language_id="python")}
    server = MagicMock(workspace=workspace)
    sessions = MagicMock()
    sessions.get.return_value = None
    sessions.is_live_or_starting.return_value = False
    return ApiContext(ls=server, sessions=sessions)


@pytest.mark.asyncio
async def test_decodes_output_without_restoring_runtime_state() -> None:
    result = await decode_saved_session(
        _context(),
        NotebookCommand(
            notebook_uri=NOTEBOOK_URI,
            inner=DecodeSavedSessionRequest(
                contents=_saved_contents(),
                marimo_version=__version__,
                notebook_version=1,
            ),
        ),
    )

    [output] = result.outputs
    assert output.cell_id == CURRENT_ID
    assert output.output is not None
    assert output.output.data == "42"
    assert output.console == []
    assert result.marimo_version == __version__
    assert result.notebook_version == 1


@pytest.mark.asyncio
async def test_omits_cells_without_saved_display_data() -> None:
    payload = json.loads(_saved_contents())
    payload["cells"][0]["outputs"] = []

    result = await decode_saved_session(
        _context(),
        NotebookCommand(
            notebook_uri=NOTEBOOK_URI,
            inner=DecodeSavedSessionRequest(
                contents=json.dumps(payload),
                marimo_version=__version__,
                notebook_version=1,
            ),
        ),
    )

    assert result.outputs == []


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "context",
    [
        pytest.param(_context(code="answer = 43"), id="edited-code"),
        pytest.param(_context(header=HEADER.replace("polars", "pandas")), id="header"),
    ],
)
async def test_incompatible_synchronized_snapshot_returns_no_outputs(
    context: ApiContext,
) -> None:
    result = await decode_saved_session(
        context,
        NotebookCommand(
            notebook_uri=NOTEBOOK_URI,
            inner=DecodeSavedSessionRequest(
                contents=_saved_contents(),
                marimo_version=__version__,
                notebook_version=1,
            ),
        ),
    )

    assert result.outputs == []


@pytest.mark.asyncio
async def test_rejects_unsynchronized_document_revision() -> None:
    result = await decode_saved_session(
        _context(),
        NotebookCommand(
            notebook_uri=NOTEBOOK_URI,
            inner=DecodeSavedSessionRequest(
                contents=_saved_contents(),
                marimo_version=__version__,
                notebook_version=2,
            ),
        ),
    )

    assert result.outputs == []
    assert result.notebook_version == 2


@pytest.mark.asyncio
async def test_drops_output_when_document_changes_during_decode() -> None:
    context = _context()

    async def decode_then_edit(
        decoder: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        result = decoder(*args, **kwargs)
        context.ls.workspace.notebook_documents[NOTEBOOK_URI].version = 2
        return result

    with patch("marimo_lsp.api.asyncio.to_thread", side_effect=decode_then_edit):
        result = await decode_saved_session(
            context,
            NotebookCommand(
                notebook_uri=NOTEBOOK_URI,
                inner=DecodeSavedSessionRequest(
                    contents=_saved_contents(),
                    marimo_version=__version__,
                    notebook_version=1,
                ),
            ),
        )

    assert result.outputs == []


@pytest.mark.asyncio
async def test_drops_output_when_document_is_reopened_during_decode() -> None:
    context = _context()

    async def decode_then_reopen(
        decoder: Callable[..., object],
        *args: object,
        **kwargs: object,
    ) -> object:
        result = decoder(*args, **kwargs)
        reopened = _context().ls.workspace.notebook_documents[NOTEBOOK_URI]
        context.ls.workspace.notebook_documents[NOTEBOOK_URI] = reopened
        return result

    with patch("marimo_lsp.api.asyncio.to_thread", side_effect=decode_then_reopen):
        result = await decode_saved_session(
            context,
            NotebookCommand(
                notebook_uri=NOTEBOOK_URI,
                inner=DecodeSavedSessionRequest(
                    contents=_saved_contents(),
                    marimo_version=__version__,
                    notebook_version=1,
                ),
            ),
        )

    assert result.outputs == []


@pytest.mark.asyncio
async def test_rejects_any_live_kernel() -> None:
    context = _context()
    sessions = MagicMock()
    sessions.is_live_or_starting.return_value = True
    context = ApiContext(ls=context.ls, sessions=sessions)

    result = await decode_saved_session(
        context,
        NotebookCommand(
            notebook_uri=NOTEBOOK_URI,
            inner=DecodeSavedSessionRequest(
                contents=_saved_contents(),
                marimo_version=__version__,
                notebook_version=1,
            ),
        ),
    )

    assert result.outputs == []


@pytest.mark.asyncio
async def test_drops_output_when_kernel_starts_during_decode() -> None:
    context = _context()
    sessions = MagicMock()
    sessions.is_live_or_starting.side_effect = [False, True]
    context = ApiContext(ls=context.ls, sessions=sessions)

    result = await decode_saved_session(
        context,
        NotebookCommand(
            notebook_uri=NOTEBOOK_URI,
            inner=DecodeSavedSessionRequest(
                contents=_saved_contents(),
                marimo_version=__version__,
                notebook_version=1,
            ),
        ),
    )

    assert result.outputs == []


@pytest.mark.asyncio
async def test_non_finite_output_is_a_json_wire_safe_cache_miss() -> None:
    payload = json.loads(_saved_contents())
    payload["cells"][0]["outputs"][0]["data"]["text/plain"] = float("nan")
    context = _context()
    params = msgspec.to_builtins(
        NotebookCommand(
            notebook_uri=NOTEBOOK_URI,
            inner=DecodeSavedSessionRequest(
                contents=json.dumps(payload),
                marimo_version=__version__,
                notebook_version=1,
            ),
        )
    )

    result = await handle_api_command(
        context.ls,
        context.sessions,
        "decode-saved-session",
        params,
    )

    wire = cast("dict[str, object]", result)
    assert wire["outputs"] == []
    json.dumps(wire, allow_nan=False)
