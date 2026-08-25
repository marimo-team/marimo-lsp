# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import asyncio
import os
import stat
import threading
from pathlib import Path
from typing import Self
from unittest.mock import AsyncMock, Mock

import pytest

from marimo_lsp.saved_session_store import (
    CallbackSavedSessionFiles,
    LocalSavedSessionFiles,
)


@pytest.mark.asyncio
async def test_local_store_replaces_the_target_atomically(tmp_path: Path) -> None:
    target = tmp_path / "__marimo__" / "session" / "notebook.py.json"
    target.parent.mkdir(parents=True)
    target.write_text("old", encoding="utf-8")
    files = LocalSavedSessionFiles()

    await files.replace(str(target), "new")

    assert target.read_text(encoding="utf-8") == "new"
    assert not list(target.parent.glob("*.tmp"))


@pytest.mark.asyncio
async def test_local_store_preserves_existing_target_permissions(
    tmp_path: Path,
) -> None:
    if os.name == "nt":
        pytest.skip("POSIX file permissions")
    target = tmp_path / "session.json"
    target.write_text("old", encoding="utf-8")
    target.chmod(0o640)

    await LocalSavedSessionFiles().replace(str(target), "new")

    assert stat.S_IMODE(target.stat().st_mode) == 0o640


@pytest.mark.asyncio
async def test_local_store_reads_an_existing_target(tmp_path: Path) -> None:
    target = tmp_path / "session.json"
    target.write_text("saved", encoding="utf-8")
    files = LocalSavedSessionFiles()

    assert await files.read(str(target)) == "saved"
    assert await files.read(str(tmp_path / "missing.json")) is None


@pytest.mark.asyncio
async def test_local_store_discards_a_stage_completed_after_cancellation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = tmp_path / "__marimo__" / "session" / "notebook.py.json"
    staged = threading.Event()
    release = threading.Event()
    original_fdopen = os.fdopen
    original_unlink = Path.unlink

    class BlockingOutput:
        def __init__(self, descriptor: int) -> None:
            self._descriptor = descriptor

        def __enter__(self) -> Self:
            return self

        def __exit__(self, *_args: object) -> None:
            os.close(self._descriptor)

        def write(self, _contents: str) -> None:
            staged.set()
            release.wait()

    def blocking_fdopen(
        descriptor: int,
        *args: object,
        **kwargs: object,
    ) -> object:
        del args, kwargs
        return BlockingOutput(descriptor)

    def unavailable_while_open(
        path: Path,
        *,
        missing_ok: bool = False,
    ) -> None:
        if not release.is_set():
            raise PermissionError(path)
        original_unlink(path, missing_ok=missing_ok)

    monkeypatch.setattr(os, "fdopen", blocking_fdopen)
    monkeypatch.setattr(Path, "unlink", unavailable_while_open)
    task = asyncio.create_task(LocalSavedSessionFiles().replace(str(target), "new"))
    await asyncio.to_thread(staged.wait)
    temporary = list(target.parent.glob("*.tmp"))

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    release.set()
    monkeypatch.setattr(os, "fdopen", original_fdopen)

    for _ in range(100):
        if temporary and not await asyncio.to_thread(temporary[0].exists):
            break
        await asyncio.sleep(0.01)

    assert temporary
    assert not await asyncio.to_thread(temporary[0].exists)
    assert not await asyncio.to_thread(target.exists)


@pytest.mark.asyncio
async def test_callback_store_commits_only_after_the_host_write() -> None:
    callbacks = Mock()
    callbacks.create.return_value = "replacement"
    callbacks.write = AsyncMock()
    files = CallbackSavedSessionFiles(callbacks)

    await files.replace("/workspace/session.json", "contents")

    callbacks.write.assert_awaited_once_with("replacement", "contents")
    callbacks.commit.assert_called_once_with("replacement")
    callbacks.discard.assert_not_called()


@pytest.mark.asyncio
async def test_callback_store_reads_through_the_host() -> None:
    callbacks = Mock()
    callbacks.read = AsyncMock(return_value="saved")
    files = CallbackSavedSessionFiles(callbacks)

    assert await files.read(r"C:\workspace\session.json") == "saved"

    callbacks.read.assert_awaited_once_with(r"C:\workspace\session.json")


@pytest.mark.asyncio
async def test_callback_store_discards_a_cancelled_host_write() -> None:
    started = asyncio.Event()

    async def write(_temporary: str, _contents: str) -> None:
        started.set()
        await asyncio.Event().wait()

    callbacks = Mock()
    callbacks.create.return_value = "replacement"
    callbacks.write.side_effect = write
    files = CallbackSavedSessionFiles(callbacks)
    task = asyncio.create_task(files.replace("/workspace/session.json", "contents"))
    await started.wait()

    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    callbacks.commit.assert_not_called()
    callbacks.discard.assert_called_once_with("replacement")
