# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

import pytest
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._runtime.commands import ExecuteCellsCommand
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t

from marimo_lsp.saved_session_writer import SavedSessionWriter

if TYPE_CHECKING:
    from marimo_lsp.app_file_manager import LspAppFileManager


class RecordingFiles:
    def __init__(self) -> None:
        self.writes: list[tuple[str, str]] = []

    async def read(self, target: str) -> str | None:
        del target
        return None

    async def write(self, target: str, contents: str) -> None:
        self.writes.append((target, contents))


@pytest.mark.asyncio
async def test_writes_a_dirty_view_in_marimo_format() -> None:
    cell_id = CellId_t("cell")
    view = SessionView()
    view.add_control_request(
        ExecuteCellsCommand(cell_ids=[cell_id], codes=["answer = 42"])
    )
    view.add_notification(
        CellNotification(
            cell_id=cell_id,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data="42",
            ),
            console=[],
            timestamp=1,
        )
    )
    manager = cast(
        "LspAppFileManager",
        SimpleNamespace(
            header=None,
            app=SimpleNamespace(
                cell_manager=SimpleNamespace(cell_ids=lambda: (cell_id,))
            ),
        ),
    )
    files = RecordingFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=manager,
        marimo_version="1.2.3",
        target="/workspace/__marimo__/session/notebook.py.json",
        files=files,
    )

    assert await writer.flush_once()
    assert not await writer.flush_once()

    [(target, contents)] = files.writes
    snapshot = json.loads(contents)
    assert target.endswith("notebook.py.json")
    assert snapshot["version"] == "1"
    assert snapshot["metadata"]["marimo_version"] == "1.2.3"
    assert snapshot["cells"][0]["outputs"][0]["data"] == {"text/plain": "42"}
