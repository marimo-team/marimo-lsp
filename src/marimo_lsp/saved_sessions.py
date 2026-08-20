# Copyright 2026 Marimo. All rights reserved.

"""Decode display outputs saved by marimo CLI sessions."""

from __future__ import annotations

import json
from typing import TYPE_CHECKING, Literal, cast

import msgspec
from marimo._messaging.notebook.document import NotebookDocument
from marimo._session.state.serialize import (
    SessionCacheKey,
    SessionCacheManager,
    deserialize_session,
)
from marimo._session.state.session_view import SessionView
from marimo._utils.code import hash_code
from marimo._utils.inline_script_metadata import read_pyproject_from_script

from marimo_lsp.loggers import get_logger

if TYPE_CHECKING:
    from collections.abc import Iterable

    from marimo._schemas.session import NotebookSessionV1
    from marimo._types.ids import CellId_t


logger = get_logger()
_MAX_SAVED_SESSION_BYTES = 64 * 1024 * 1024
_SIZE_CHUNK_CHARACTERS = 1024 * 1024

# TODO: Replace this adapter when marimo exposes a content-based session
# reader. SessionCacheManager currently couples decoding to local filesystem
# access, which cannot represent every VS Code workspace.


class _DataOutput(msgspec.Struct, tag="data", tag_field="type"):
    data: dict[str, object]


class _ErrorOutput(msgspec.Struct, tag="error", tag_field="type"):
    ename: str
    evalue: str
    # marimo's declared V1 schema says list[str], while its serializer writes
    # the exception model's formatted HTML string or None.
    traceback: list[str] | str | None


type _Output = _DataOutput | _ErrorOutput


class _StreamOutput(msgspec.Struct, tag="stream", tag_field="type"):
    name: Literal["stdout", "stderr"]
    text: str
    # Keep MIME types open to additions made by newer marimo versions that
    # retain the backwards-compatible V1 wire format.
    mimetype: str | None = None


class _StreamMediaOutput(msgspec.Struct, tag="streamMedia", tag_field="type"):
    name: Literal["media"]
    data: str
    mimetype: str


type _Console = _StreamOutput | _StreamMediaOutput


class _Cell(msgspec.Struct):
    id: str
    code_hash: str | None
    outputs: list[_Output]
    console: list[_Console]


class _Metadata(msgspec.Struct):
    marimo_version: str | None
    script_metadata_hash: str | None


class _SavedSessionV1(msgspec.Struct):
    version: Literal["1"]
    metadata: _Metadata
    cells: list[_Cell]


def _script_metadata_hash(header: str | None) -> str | None:
    try:
        project = read_pyproject_from_script(header or "")
    except Exception:  # noqa: BLE001 - parity with marimo's filename helper
        # Match marimo's filename-based helper: malformed PEP 723 metadata is
        # treated as absent rather than making the session cache unreadable.
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


def _within_size_limit(contents: str) -> bool:
    if len(contents) > _MAX_SAVED_SESSION_BYTES:
        return False

    encoded_size = 0
    try:
        for start in range(0, len(contents), _SIZE_CHUNK_CHARACTERS):
            encoded_size += len(
                contents[start : start + _SIZE_CHUNK_CHARACTERS].encode("utf-8")
            )
            if encoded_size > _MAX_SAVED_SESSION_BYTES:
                return False
    except (MemoryError, UnicodeEncodeError):
        return False
    return True


def decode_saved_session_view(
    contents: str,
    *,
    codes: Iterable[str],
    cell_ids: Iterable[CellId_t],
    marimo_version: str | None,
    header: str | None,
) -> SessionView | None:
    """Decode a compatible marimo session sidecar, if one can be proven.

    ``codes``, ``cell_ids``, and ``header`` must come from the same synchronized
    notebook snapshot. Deriving the PEP 723 hash here keeps every cache-key
    component on the language-server side of that boundary.
    """
    if marimo_version is None or not _within_size_limit(contents):
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
        script_metadata_hash = _script_metadata_hash(header)
        decoded = msgspec.convert(
            json.loads(contents),
            type=_SavedSessionV1,
        )
        notebook_session = cast(
            "NotebookSessionV1",
            msgspec.to_builtins(decoded),
        )
        key = SessionCacheKey(
            codes=current_codes,
            marimo_version=marimo_version,
            cell_ids=current_cell_ids,
            script_metadata_hash=script_metadata_hash,
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
