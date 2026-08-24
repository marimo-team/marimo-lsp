# Copyright 2026 Marimo. All rights reserved.

"""Tests for replaying marimo session output notifications."""

from __future__ import annotations

import asyncio
import json
from typing import cast
from unittest.mock import AsyncMock, MagicMock

import lsprotocol.types as lsp
import msgspec
import pytest
from marimo import __version__
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._runtime.commands import ExecuteCellsCommand
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t

from marimo_lsp.api import ApiContext, handle_api_command, read_session_outputs
from marimo_lsp.models import (
    NotebookCommand,
    ReadSessionOutputsRequest,
    SavedSessionLocation,
)
from marimo_lsp.saved_sessions import serialize_saved_session_view
from marimo_lsp.sessions import Session, Sessions

NOTEBOOK_URI = "file:///workspace/notebook.py"
CELL_URI = f"{NOTEBOOK_URI}#cell"
SAVED_ID = CellId_t("saved")
CURRENT_ID = CellId_t("current")
CODE = "answer = 42\nanswer"
CACHE_PATH = "/workspace/__marimo__/session/notebook.py.json"


def _metadata(value: dict[str, object]) -> lsp.LSPObject:
    return cast("lsp.LSPObject", value)


def _workspace(*, code: str = CODE) -> MagicMock:
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
        metadata=_metadata({"marimo": {"header": None}}),
    )
    workspace = MagicMock()
    workspace.notebook_documents = {NOTEBOOK_URI: notebook}
    workspace.text_documents = {CELL_URI: MagicMock(source=code, language_id="python")}
    return workspace


def _view(
    cell_id: CellId_t,
    *,
    output: str | dict[str, float] = "42",
) -> SessionView:
    view = SessionView()
    view.add_control_request(ExecuteCellsCommand(cell_ids=[cell_id], codes=[CODE]))
    view.add_notification(
        CellNotification(
            cell_id=cell_id,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data=output,
            ),
            console=[],
            timestamp=1,
        )
    )
    return view


def _saved_contents() -> str:
    snapshot = serialize_saved_session_view(
        _view(SAVED_ID),
        cell_ids=[SAVED_ID],
        marimo_version=__version__,
        header=None,
    )
    assert snapshot is not None
    return json.dumps(snapshot)


def _request(
    location: SavedSessionLocation | None,
) -> NotebookCommand[ReadSessionOutputsRequest]:
    return NotebookCommand(
        notebook_uri=NOTEBOOK_URI,
        inner=ReadSessionOutputsRequest(location=location),
    )


@pytest.mark.asyncio
async def test_reads_sidecar_into_marimo_cell_notifications() -> None:
    files = MagicMock()
    files.read = AsyncMock(return_value=_saved_contents())
    files.replace = AsyncMock()
    kernels = MagicMock()
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=kernels, saved_session_files=files)

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(
            SavedSessionLocation(
                cache_path=CACHE_PATH,
                marimo_version=__version__,
            )
        ),
    )

    [notification] = result.notifications
    assert isinstance(notification, CellNotification)
    assert notification.cell_id == CURRENT_ID
    assert notification.output is not None
    assert notification.output.data == "42"
    assert notification.stale_inputs is True
    files.read.assert_awaited_once_with(CACHE_PATH)
    kernels.launch.assert_not_called()


@pytest.mark.asyncio
async def test_live_session_view_is_authoritative() -> None:
    files = MagicMock()
    files.read = AsyncMock(return_value=_saved_contents())
    files.replace = AsyncMock()
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)
    session = MagicMock(spec=Session)
    session.requires_restart = False
    session.session_view = _view(CURRENT_ID, output="live")
    session.app.cell_manager.cell_ids.return_value = [CURRENT_ID]
    session.app.cell_manager.code_lookup.return_value = {CURRENT_ID: CODE}
    sessions._sessions[NOTEBOOK_URI] = session

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(
            SavedSessionLocation(
                cache_path=CACHE_PATH,
                marimo_version=__version__,
            )
        ),
    )

    [notification] = result.notifications
    assert isinstance(notification, CellNotification)
    assert notification.output is not None
    assert notification.output.data == "live"
    assert notification.stale_inputs is not True
    files.read.assert_not_awaited()


@pytest.mark.asyncio
async def test_live_session_output_is_stale_when_source_changed() -> None:
    server = MagicMock(workspace=_workspace(code="value = 2"))
    sessions = Sessions(server, kernels=MagicMock())
    session = MagicMock(spec=Session)
    session.requires_restart = False
    session.session_view = _view(CURRENT_ID, output="live")
    session.app.cell_manager.code_lookup.return_value = {CURRENT_ID: "value = 2"}
    sessions._sessions[NOTEBOOK_URI] = session

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(None),
    )

    [notification] = result.notifications
    assert notification.output is not None
    assert notification.output.data == "live"
    assert notification.stale_inputs is True


@pytest.mark.asyncio
async def test_live_in_flight_cell_is_replayed_before_it_has_output() -> None:
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=MagicMock())
    session = MagicMock(spec=Session)
    session.requires_restart = False
    view = SessionView()
    view.add_control_request(ExecuteCellsCommand(cell_ids=[CURRENT_ID], codes=[CODE]))
    view.add_notification(
        CellNotification(
            cell_id=CURRENT_ID,
            status="running",
            run_id="surviving-run",
            output=None,
            console=[],
            timestamp=1,
        )
    )
    session.session_view = view
    session.app.cell_manager.code_lookup.return_value = {CURRENT_ID: CODE}
    sessions._sessions[NOTEBOOK_URI] = session

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(None),
    )

    [notification] = result.notifications
    assert notification.status == "running"
    assert notification.run_id == "surviving-run"
    assert notification.output is None


@pytest.mark.asyncio
async def test_invalidated_live_view_is_rebased_without_waiting_for_disk() -> None:
    files = MagicMock()
    files.read = AsyncMock(return_value=None)
    files.replace = AsyncMock()
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)
    session = MagicMock(spec=Session)
    session.requires_restart = True
    session.marimo_version = __version__
    session.session_view = _view(SAVED_ID, output="not yet flushed")
    session.app_file_manager.header = None
    session.app_file_manager.app.cell_manager.cell_ids.return_value = [SAVED_ID]
    sessions._sessions[NOTEBOOK_URI] = session

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(None),
    )

    [notification] = result.notifications
    assert notification.cell_id == CURRENT_ID
    assert notification.output is not None
    assert notification.output.data == "not yet flushed"
    assert notification.stale_inputs is True
    files.read.assert_not_awaited()


@pytest.mark.asyncio
async def test_no_live_session_or_location_is_empty() -> None:
    files = MagicMock()
    files.read = AsyncMock(return_value=_saved_contents())
    files.replace = AsyncMock()
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(None),
    )

    assert result.notifications == []
    files.read.assert_not_awaited()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("contents", "version", "code"),
    [
        (None, __version__, CODE),
        ("{", __version__, CODE),
        (_saved_contents(), "0.0.0", CODE),
        (_saved_contents(), __version__, "answer = 43"),
    ],
)
async def test_unavailable_or_incompatible_sidecar_is_empty(
    contents: str | None,
    version: str,
    code: str,
) -> None:
    files = MagicMock()
    files.read = AsyncMock(return_value=contents)
    files.replace = AsyncMock()
    server = MagicMock(workspace=_workspace(code=code))
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(
            SavedSessionLocation(
                cache_path=CACHE_PATH,
                marimo_version=version,
            )
        ),
    )

    assert result.notifications == []


@pytest.mark.asyncio
async def test_read_discards_output_when_document_reopens() -> None:
    workspace = _workspace()

    async def reopen(_target: str) -> str:
        workspace.notebook_documents[NOTEBOOK_URI] = _workspace().notebook_documents[
            NOTEBOOK_URI
        ]
        return _saved_contents()

    files = MagicMock()
    files.read = AsyncMock(side_effect=reopen)
    files.replace = AsyncMock()
    server = MagicMock(workspace=workspace)
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(
            SavedSessionLocation(
                cache_path=CACHE_PATH,
                marimo_version=__version__,
            )
        ),
    )

    assert result.notifications == []


@pytest.mark.asyncio
async def test_read_discards_output_when_the_open_document_changes() -> None:
    workspace = _workspace()

    async def edit(_target: str) -> str:
        notebook = workspace.notebook_documents[NOTEBOOK_URI]
        notebook.version = 2
        workspace.text_documents[CELL_URI].source = "answer = 43"
        return _saved_contents()

    files = MagicMock()
    files.read = AsyncMock(side_effect=edit)
    files.replace = AsyncMock()
    server = MagicMock(workspace=workspace)
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(
            SavedSessionLocation(
                cache_path=CACHE_PATH,
                marimo_version=__version__,
            )
        ),
    )

    assert result.notifications == []


@pytest.mark.asyncio
async def test_read_does_not_block_a_new_live_session() -> None:
    read_started = asyncio.Event()
    finish_read = asyncio.Event()

    async def read(_target: str) -> str:
        read_started.set()
        await finish_read.wait()
        return _saved_contents()

    files = MagicMock()
    files.read = AsyncMock(side_effect=read)
    files.replace = AsyncMock()
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)
    pending = asyncio.ensure_future(
        read_session_outputs(
            ApiContext(ls=server, sessions=sessions),
            _request(
                SavedSessionLocation(
                    cache_path=CACHE_PATH,
                    marimo_version=__version__,
                )
            ),
        )
    )
    await read_started.wait()

    live = MagicMock(spec=Session)
    live.requires_restart = False
    live.session_view = _view(CURRENT_ID, output="live")
    live.app.cell_manager.cell_ids.return_value = [CURRENT_ID]
    live.app.cell_manager.code_lookup.return_value = {CURRENT_ID: CODE}

    async def install() -> None:
        async with sessions._lifecycle_lock(NOTEBOOK_URI):
            sessions._sessions[NOTEBOOK_URI] = live

    await asyncio.wait_for(install(), timeout=0.1)
    finish_read.set()

    result = await pending
    [notification] = result.notifications
    assert notification.output is not None
    assert notification.output.data == "live"
    assert notification.stale_inputs is not True


@pytest.mark.asyncio
async def test_callback_store_receives_opaque_host_path() -> None:
    windows_path = r"C:\workspace\__marimo__\session\notebook.py.json"
    files = MagicMock()
    files.read = AsyncMock(return_value=_saved_contents())
    files.replace = AsyncMock()
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=MagicMock(), saved_session_files=files)

    result = await read_session_outputs(
        ApiContext(ls=server, sessions=sessions),
        _request(
            SavedSessionLocation(
                cache_path=windows_path,
                marimo_version=__version__,
            )
        ),
    )

    assert len(result.notifications) == 1
    files.read.assert_awaited_once_with(windows_path)


@pytest.mark.asyncio
async def test_non_finite_notification_uses_marimo_wire_normalization() -> None:
    server = MagicMock(workspace=_workspace())
    sessions = Sessions(server, kernels=MagicMock())
    session = MagicMock(spec=Session)
    session.requires_restart = False
    session.session_view = _view(CURRENT_ID, output={"value": float("nan")})
    session.app.cell_manager.cell_ids.return_value = [CURRENT_ID]
    session.app.cell_manager.code_lookup.return_value = {CURRENT_ID: CODE}
    sessions._sessions[NOTEBOOK_URI] = session

    wire = await handle_api_command(
        server,
        sessions,
        "read-session-outputs",
        msgspec.to_builtins(_request(None)),
    )

    encoded = json.dumps(wire, allow_nan=False)
    assert json.loads(encoded)["notifications"][0]["output"]["data"] == {"value": None}
