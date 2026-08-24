# Copyright 2026 Marimo. All rights reserved.

"""Persist a live marimo SessionView using marimo's cache lifecycle."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from marimo_lsp.loggers import get_logger
from marimo_lsp.saved_sessions import serialize_saved_session_view

if TYPE_CHECKING:
    from marimo._session.state.session_view import SessionView

    from marimo_lsp.app_file_manager import LspAppFileManager
    from marimo_lsp.saved_session_store import SavedSessionFiles


logger = get_logger()

SESSION_CACHE_INTERVAL_SECONDS = 2


class SavedSessionWriter:
    """Periodically persist one authoritative language-server session."""

    def __init__(  # noqa: PLR0913
        self,
        *,
        view: SessionView,
        app_file_manager: LspAppFileManager,
        marimo_version: str,
        target: str,
        files: SavedSessionFiles,
        interval: float = SESSION_CACHE_INTERVAL_SECONDS,
        pending: bool = False,
    ) -> None:
        self._view = view
        self._app_file_manager = app_file_manager
        self._marimo_version = marimo_version
        self._target = target
        self._files = files
        self._interval = interval
        self._pending = pending
        self._writing = False
        self._generation = 0
        self._task: asyncio.Task[None] | None = None

    @property
    def running(self) -> bool:
        """Return whether the periodic writer is active."""
        return self._task is not None and not self._task.done()

    def start(self) -> None:
        """Start polling, if it is not already active."""
        if self.running:
            return
        generation = self._generation
        self._task = asyncio.create_task(self._run(generation))

    def stop(self) -> bool:
        """Stop polling and return whether the next writer must retry."""
        self._generation += 1
        if self._writing:
            self._pending = True
        task = self._task
        self._task = None
        if task is not None and not task.done():
            task.cancel()
        return self._pending

    async def flush_once(self) -> bool:
        """Write one dirty snapshot. Exposed for lifecycle tests."""
        if not self._pending and not self._view.needs_export("session"):
            return False
        return await self._write(self._generation)

    async def _run(self, generation: int) -> None:
        while generation == self._generation:
            try:
                await self.flush_once()
                await asyncio.sleep(self._interval)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Stopped saved-session writer after write failure")
                return

    async def _write(self, generation: int) -> bool:
        cell_manager = self._app_file_manager.app.cell_manager
        cell_ids = tuple(cell_manager.cell_ids())
        codes = tuple(cell_manager.codes())
        if len(cell_ids) != len(codes) or any(
            code
            and (
                self._view.last_executed_code.get(cell_id) != code
                or cell_id not in self._view.cell_notifications
            )
            for cell_id, code in zip(cell_ids, codes, strict=False)
        ):
            return False

        self._pending = False
        self._writing = True
        self._view.mark_auto_export_session()
        try:
            snapshot = serialize_saved_session_view(
                self._view,
                cell_ids=cell_ids,
                marimo_version=self._marimo_version,
                header=self._app_file_manager.header,
            )
            if snapshot is None:
                self._pending = True
                msg = "Unable to serialize saved session"
                raise RuntimeError(msg)  # noqa: TRY301 - retain retry state
            contents = json.dumps(snapshot, indent=2)
            await self._files.replace(self._target, contents)
            if generation != self._generation:
                return False
        except asyncio.CancelledError:
            self._pending = True
            raise
        except BaseException:
            self._pending = True
            raise
        else:
            return True
        finally:
            self._writing = False
