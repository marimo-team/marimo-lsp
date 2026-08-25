# Copyright 2026 Marimo. All rights reserved.

"""Compatibility helpers for marimo saved-session snapshots."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, cast

import msgspec
from marimo._messaging.notebook.document import NotebookDocument
from marimo._messaging.notification import CellNotification
from marimo._session.state.serialize import (
    SessionCacheKey,
    SessionCacheManager,
    deserialize_session,
    serialize_session_view,
)
from marimo._session.state.session_view import SessionView
from marimo._utils.code import hash_code
from marimo._utils.inline_script_metadata import read_pyproject_from_script

if TYPE_CHECKING:
    from collections.abc import Iterable

    from marimo._schemas.session import NotebookSessionV1
    from marimo._types.ids import CellId_t


def _script_metadata_hash(header: str | None) -> str | None:
    try:
        project = read_pyproject_from_script(header or "")
    except Exception:  # noqa: BLE001 - match marimo's filename helper
        return None
    if project is None:
        return None
    return hash_code(
        json.dumps(
            project,
            sort_keys=True,
            separators=(",", ":"),
            ensure_ascii=False,
        )
    )


def serialize_saved_session(
    view: SessionView,
    *,
    cell_ids: Iterable[CellId_t],
    marimo_version: str,
    header: str | None,
) -> NotebookSessionV1:
    """Serialize a view with the selected kernel's cache identity."""
    snapshot = serialize_session_view(
        view,
        cell_ids=tuple(cell_ids),
        script_metadata_hash=_script_metadata_hash(header),
        drop_virtual_file_outputs=True,
    )
    snapshot["metadata"]["marimo_version"] = marimo_version
    return snapshot


def decode_saved_session_outputs(
    contents: str,
    *,
    codes: Iterable[str],
    cell_ids: Iterable[CellId_t],
    header: str | None,
) -> list[CellNotification]:
    """Return cold display notifications from a compatible V1 snapshot."""
    try:
        decoded = json.loads(contents)
        if not isinstance(decoded, dict) or decoded.get("version") != "1":
            return []
        metadata = decoded.get("metadata")
        if not isinstance(metadata, dict):
            return []
        marimo_version = metadata.get("marimo_version")
        if not isinstance(marimo_version, str):
            return []
        view = decode_saved_session_view(
            contents,
            codes=codes,
            cell_ids=cell_ids,
            marimo_version=marimo_version,
            header=header,
        )
        if view is None:
            return []
        return [
            msgspec.structs.replace(notification, stale_inputs=True)
            for notification in view.notifications
            if isinstance(notification, CellNotification)
            and (notification.output is not None or bool(notification.console))
        ]
    except Exception:  # noqa: BLE001 - malformed snapshots are cache misses
        return []


def decode_saved_session_view(
    contents: str,
    *,
    codes: Iterable[str],
    cell_ids: Iterable[CellId_t],
    marimo_version: str,
    header: str | None,
) -> SessionView | None:
    """Restore a compatible snapshot into the current cell IDs."""
    try:
        notebook_session = cast("NotebookSessionV1", json.loads(contents))
        current_codes = tuple(codes)
        current_cell_ids = tuple(cell_ids)
        if len(current_codes) != len(current_cell_ids):
            return None
        manager = SessionCacheManager(
            session_view=SessionView(),
            document=NotebookDocument([]),
            path=None,
            interval=1,
        )
        key = SessionCacheKey(
            codes=current_codes,
            marimo_version=marimo_version,
            cell_ids=current_cell_ids,
            script_metadata_hash=_script_metadata_hash(header),
        )
        if not manager.is_cache_hit(notebook_session, key):
            return None
        cell_ids_by_hash = {
            hash_code(code): cell_id
            for code, cell_id in zip(
                current_codes,
                current_cell_ids,
                strict=True,
            )
            if code
        }
        return deserialize_session(notebook_session, cell_ids_by_hash)
    except Exception:  # noqa: BLE001 - malformed snapshots are cache misses
        return None
