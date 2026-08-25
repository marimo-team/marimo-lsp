# Copyright 2026 Marimo. All rights reserved.

"""Periodically persist one live marimo SessionView."""

from __future__ import annotations

import asyncio
import json
from typing import TYPE_CHECKING

from marimo_lsp.loggers import get_logger
from marimo_lsp.saved_sessions import serialize_saved_session

if TYPE_CHECKING:
    from marimo._session.state.session_view import SessionView

    from marimo_lsp.app_file_manager import LspAppFileManager
    from marimo_lsp.saved_session_store import SavedSessionFiles


logger = get_logger()
SESSION_CACHE_INTERVAL_SECONDS = 2


class SavedSessionWriter:
    """Mirror marimo's session-owned periodic cache writer."""

    def __init__(  # noqa: PLR0913
        self,
        *,
        view: SessionView,
        app_file_manager: LspAppFileManager,
        marimo_version: str,
        target: str,
        files: SavedSessionFiles,
        interval: float = SESSION_CACHE_INTERVAL_SECONDS,
    ) -> None:
        self._view = view
        self._app_file_manager = app_file_manager
        self._marimo_version = marimo_version
        self._target = target
        self._files = files
        self._interval = interval
        self._task: asyncio.Task[None] | None = None

    def start(self) -> None:
        """Start the periodic writer."""
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._run())

    def stop(self) -> None:
        """Stop the periodic writer."""
        if self._task is not None:
            self._task.cancel()
            self._task = None

    async def flush_once(self) -> bool:
        """Write the current view when marimo marks it dirty."""
        if not self._view.needs_export("session"):
            return False
        self._view.mark_auto_export_session()
        cells = self._app_file_manager.app.cell_manager
        snapshot = serialize_saved_session(
            self._view,
            cell_ids=cells.cell_ids(),
            marimo_version=self._marimo_version,
            header=self._app_file_manager.header,
        )
        await self._files.write(self._target, json.dumps(snapshot, indent=2))
        return True

    async def _run(self) -> None:
        while True:
            try:
                await self.flush_once()
                await asyncio.sleep(self._interval)
            except asyncio.CancelledError:
                raise
            except Exception:
                logger.exception("Stopped saved-session writer after write failure")
                return
