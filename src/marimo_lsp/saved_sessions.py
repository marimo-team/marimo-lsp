# Copyright 2026 Marimo. All rights reserved.

"""Read and write marimo saved-session data."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, cast

from marimo._messaging.notebook.document import NotebookDocument
from marimo._session.state.serialize import (
    SessionCacheKey,
    SessionCacheManager,
    deserialize_session,
    serialize_session_view,
)
from marimo._session.state.session_view import SessionView
from marimo._utils.code import hash_code
from marimo._utils.inline_script_metadata import read_pyproject_from_script

from marimo_lsp.kernels import normalize_marimo_version
from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
    from collections.abc import Iterable

    from marimo._schemas.session import NotebookSessionV1
    from marimo._types.ids import CellId_t


logger = get_logger()
# TODO: Replace this adapter when marimo exposes content-based session I/O.
# SessionCacheManager currently couples the wire format to local paths and the
# marimo version imported by this language-server process.


def _script_metadata_hash(header: str | None) -> str | None:
    try:
        project = read_pyproject_from_script(header or "")
    except Exception:  # noqa: BLE001 - parity with marimo's filename helper
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


def serialize_saved_session_view(
    view: SessionView,
    *,
    cell_ids: Iterable[CellId_t],
    marimo_version: str | None,
    header: str | None,
) -> NotebookSessionV1 | None:
    """Serialize a live view with the selected kernel's cache identity."""
    try:
        marimo_version = normalize_marimo_version(marimo_version)
        if marimo_version is None:
            return None
        notebook_session = serialize_session_view(
            view,
            cell_ids=tuple(cell_ids),
            drop_virtual_file_outputs=True,
            script_metadata_hash=_script_metadata_hash(header),
        )
        # The SessionView belongs to the selected kernel. Cache compatibility
        # therefore uses that kernel's version, not marimo-base's version.
        notebook_session["metadata"]["marimo_version"] = marimo_version
    except Exception:
        logger.exception("Ignored unserializable saved session")
        return None
    return notebook_session


def decode_saved_session_view(
    contents: str,
    *,
    codes: Iterable[str],
    cell_ids: Iterable[CellId_t],
    marimo_version: str | None,
    header: str | None,
) -> SessionView | None:
    """Decode a compatible marimo session sidecar, if one can be proven."""
    marimo_version = normalize_marimo_version(marimo_version)
    if marimo_version is None:
        return None

    current_codes = tuple(codes)
    current_cell_ids = tuple(cell_ids)
    code_hashes = tuple(hash_code(code) for code in current_codes if code)
    if (
        len(current_codes) != len(current_cell_ids)
        or len(current_cell_ids) != len(set(current_cell_ids))
        or len(code_hashes) != len(set(code_hashes))
    ):
        return None

    manager = SessionCacheManager(
        session_view=SessionView(),
        document=NotebookDocument([]),
        path=None,
        interval=1,
    )
    try:
        decoded = json.loads(contents)
        if not isinstance(decoded, dict) or decoded.get("version") != "1":
            return None
        # Delegate field and output compatibility to marimo. In particular,
        # its V1 reader skips future output tags instead of rejecting the
        # otherwise-compatible session.
        notebook_session = cast("NotebookSessionV1", decoded)
        key = SessionCacheKey(
            codes=current_codes,
            marimo_version=marimo_version,
            cell_ids=current_cell_ids,
            script_metadata_hash=_script_metadata_hash(header),
        )
        if not manager.is_cache_hit(notebook_session, key):
            return None

        code_hash_to_cell_id = {
            hash_code(code): cell_id
            for code, cell_id in zip(
                current_codes,
                current_cell_ids,
                strict=True,
            )
            if code
        }
        return deserialize_session(notebook_session, code_hash_to_cell_id)
    except Exception:
        logger.exception("Ignored malformed saved session")
        return None
