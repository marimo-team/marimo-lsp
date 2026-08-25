# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import asyncio
import json
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast

import pytest
from marimo._messaging.cell_output import CellChannel, CellOutput
from marimo._messaging.notification import CellNotification
from marimo._runtime.commands import ExecuteCellsCommand, UpdateUserConfigCommand
from marimo._session.state.session_view import SessionView
from marimo._types.ids import CellId_t

from marimo_lsp.saved_session_writer import SavedSessionWriter
from marimo_lsp.saved_sessions import decode_saved_session_view

if TYPE_CHECKING:
    from pathlib import Path

    from marimo_lsp.app_file_manager import LspAppFileManager

CELL_ID = CellId_t("cell")
SECOND_CELL_ID = CellId_t("second")


class RecordingFiles:
    def __init__(self) -> None:
        self.attempted: list[tuple[str, str]] = []
        self.completed: list[tuple[str, str]] = []

    async def read(self, target: str) -> str | None:
        del target
        return None

    async def replace(self, target: str, contents: str) -> None:
        self.attempted.append((target, contents))
        self.completed.append((target, contents))


def _view(output: str = "first") -> SessionView:
    view = SessionView()
    view.add_control_request(
        ExecuteCellsCommand(cell_ids=[CELL_ID], codes=["value = 1"])
    )
    view.add_notification(
        CellNotification(
            cell_id=CELL_ID,
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


def _manager(
    header: str | None = None,
    cell_ids: tuple[CellId_t, ...] = (CELL_ID,),
    codes: tuple[str, ...] = ("value = 1",),
) -> SimpleNamespace:
    return SimpleNamespace(
        header=header,
        app=SimpleNamespace(
            cell_manager=SimpleNamespace(
                cell_ids=lambda: cell_ids,
                codes=lambda: codes,
            )
        ),
    )


@pytest.mark.asyncio
async def test_writer_uses_upstream_format_and_selected_version(
    tmp_path: Path,
) -> None:
    view = _view()
    files = RecordingFiles()
    target = str(tmp_path / "session.json")
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast("LspAppFileManager", _manager()),
        marimo_version="1.2.3-rc1+build.7",
        target=target,
        files=files,
    )

    assert await writer.flush_once()
    assert not await writer.flush_once()

    payload = json.loads(files.completed[0][1])
    assert payload["version"] == "1"
    assert payload["metadata"]["marimo_version"] == "1.2.3-rc1+build.7"
    assert payload["cells"][0]["outputs"][0]["data"] == {"text/plain": "first"}
    assert files.completed[0][0] == target


@pytest.mark.asyncio
async def test_change_during_stage_remains_dirty_for_the_next_tick(
    tmp_path: Path,
) -> None:
    view = _view()
    started = asyncio.Event()
    release = asyncio.Event()

    class BlockingFiles(RecordingFiles):
        async def replace(self, target: str, contents: str) -> None:
            self.attempted.append((target, contents))
            if len(self.attempted) == 1:
                started.set()
                await release.wait()
            self.completed.append((target, contents))

    files = BlockingFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast("LspAppFileManager", _manager()),
        marimo_version="1.2.3",
        target=str(tmp_path / "session.json"),
        files=files,
    )
    first = asyncio.create_task(writer.flush_once())
    await started.wait()

    view.add_notification(
        CellNotification(
            cell_id=CELL_ID,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data="second",
            ),
            console=[],
            timestamp=2,
        )
    )
    release.set()

    assert await first
    assert view.needs_export("session")
    assert await writer.flush_once()
    assert len(files.completed) == 2
    assert json.loads(files.completed[1][1])["cells"][0]["outputs"][0]["data"] == {
        "text/plain": "second"
    }


@pytest.mark.asyncio
async def test_partial_run_retains_an_untouched_restored_output(
    tmp_path: Path,
) -> None:
    view = SessionView()
    for cell_id, output in ((CELL_ID, "old first"), (SECOND_CELL_ID, "old second")):
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
    view.mark_auto_export_session()
    view.add_control_request(
        ExecuteCellsCommand(
            cell_ids=[CELL_ID, SECOND_CELL_ID],
            codes=["first = 1", "second = 2"],
        )
    )
    view.add_notification(
        CellNotification(
            cell_id=CELL_ID,
            status="idle",
            output=CellOutput(
                channel=CellChannel.OUTPUT,
                mimetype="text/plain",
                data="new first",
            ),
            console=[],
            timestamp=2,
        )
    )
    files = RecordingFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast(
            "LspAppFileManager",
            _manager(
                cell_ids=(CELL_ID, SECOND_CELL_ID),
                codes=("first = 1", "second = 2"),
            ),
        ),
        marimo_version="1.2.3",
        target=str(tmp_path / "session.json"),
        files=files,
    )

    assert await writer.flush_once()

    payload = json.loads(files.completed[0][1])
    assert payload["cells"][0]["outputs"][0]["data"] == {"text/plain": "new first"}
    assert payload["cells"][1]["outputs"][0]["data"] == {"text/plain": "old second"}


@pytest.mark.asyncio
async def test_restored_view_waits_for_the_current_notebook_graph(
    tmp_path: Path,
) -> None:
    view = _view()
    view.last_executed_code.clear()
    view.mark_auto_export_session()
    view.add_control_request(UpdateUserConfigCommand(config={}))
    files = RecordingFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast("LspAppFileManager", _manager()),
        marimo_version="1.2.3",
        target=str(tmp_path / "session.json"),
        files=files,
    )

    assert not await writer.flush_once()
    assert files.attempted == []

    view.add_control_request(
        ExecuteCellsCommand(cell_ids=[CELL_ID], codes=["value = 1"])
    )

    assert await writer.flush_once()
    assert json.loads(files.completed[0][1])["cells"][0]["code_hash"] is not None


@pytest.mark.asyncio
async def test_writer_waits_for_a_notification_for_each_nonempty_cell(
    tmp_path: Path,
) -> None:
    view = SessionView()
    view.add_control_request(
        ExecuteCellsCommand(cell_ids=[CELL_ID], codes=["value = 1"])
    )
    files = RecordingFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast("LspAppFileManager", _manager()),
        marimo_version="1.2.3",
        target=str(tmp_path / "session.json"),
        files=files,
    )

    assert not await writer.flush_once()
    assert files.attempted == []

    view.add_notification(
        CellNotification(
            cell_id=CELL_ID,
            status="idle",
            output=None,
            console=[],
            timestamp=1,
        )
    )

    assert await writer.flush_once()
    restored = decode_saved_session_view(
        files.completed[0][1],
        codes=("value = 1",),
        cell_ids=(CELL_ID,),
        marimo_version="1.2.3",
        header=None,
    )
    assert restored is not None


@pytest.mark.asyncio
async def test_pending_restored_view_waits_for_instantiation(
    tmp_path: Path,
) -> None:
    view = _view()
    view.last_executed_code.clear()
    view.mark_auto_export_session()
    files = RecordingFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast("LspAppFileManager", _manager()),
        marimo_version="1.2.3",
        target=str(tmp_path / "session.json"),
        files=files,
        pending=True,
    )

    assert not await writer.flush_once()
    assert writer.stop()
    assert files.attempted == []

    view.add_control_request(
        ExecuteCellsCommand(cell_ids=[CELL_ID], codes=["value = 1"])
    )

    assert await writer.flush_once()


@pytest.mark.asyncio
async def test_stop_discards_an_in_flight_stage_and_retries_on_restart(
    tmp_path: Path,
) -> None:
    view = _view()
    started = asyncio.Event()

    class BlockingFiles(RecordingFiles):
        async def replace(self, target: str, contents: str) -> None:
            self.attempted.append((target, contents))
            if len(self.attempted) == 1:
                started.set()
                await asyncio.Event().wait()
            self.completed.append((target, contents))

    files = BlockingFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast("LspAppFileManager", _manager()),
        marimo_version="1.2.3",
        target=str(tmp_path / "session.json"),
        files=files,
        interval=0,
    )
    writer.start()
    await started.wait()

    assert writer.stop()
    await asyncio.sleep(0)
    writer.start()
    for _ in range(100):
        if files.completed:
            break
        await asyncio.sleep(0)
    writer.stop()

    assert len(files.attempted) == 2
    assert files.completed == [files.attempted[1]]


@pytest.mark.asyncio
async def test_failed_write_remains_pending_for_a_lifecycle_restart(
    tmp_path: Path,
) -> None:
    view = _view()

    class FailOnceFiles(RecordingFiles):
        async def replace(self, target: str, contents: str) -> None:
            self.attempted.append((target, contents))
            if len(self.attempted) == 1:
                message = "unavailable"
                raise OSError(message)
            self.completed.append((target, contents))

    files = FailOnceFiles()
    writer = SavedSessionWriter(
        view=view,
        app_file_manager=cast("LspAppFileManager", _manager()),
        marimo_version="1.2.3",
        target=str(tmp_path / "session.json"),
        files=files,
    )

    with pytest.raises(OSError, match="unavailable"):
        await writer.flush_once()

    assert writer.stop()
    assert await writer.flush_once()
    assert files.completed == [files.attempted[1]]
