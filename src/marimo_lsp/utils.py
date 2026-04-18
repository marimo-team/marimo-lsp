"""Utility functions for marimo notebooks."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast
from urllib.parse import unquote

from marimo._types.ids import CellId_t

from marimo_lsp.loggers import get_logger

logger = get_logger()

if TYPE_CHECKING:
    import lsprotocol.types as lsp
    from pygls.workspace import Workspace
    from pygls.workspace.text_document import TextDocument


def find_text_document(workspace: Workspace, uri: str) -> TextDocument | None:
    """Look up a text document, tolerating percent-encoding mismatches.

    VS Code URIs can round-trip through encodings that pygls's workspace key
    doesn't match literally (e.g. the base64 ``==`` tail on cell fragments
    vs ``%3D%3D`` in the wire URI). Try the raw URI first, then the
    unquoted form (the common case — pygls stores the decoded URI) before
    falling back to an O(n) scan for the reverse mismatch.
    """
    docs = workspace.text_documents
    doc = docs.get(uri)
    if doc is not None:
        return doc

    normalized = unquote(uri)
    if normalized != uri:
        doc = docs.get(normalized)
        if doc is not None:
            return doc

    # Reverse mismatch: lookup key is decoded, stored key is encoded.
    for key, value in docs.items():
        if unquote(key) == normalized:
            return value
    return None


def get_stable_id(cell: lsp.NotebookCell) -> CellId_t | None:
    """Get the stable ID of a marimo notebook cell."""
    return decode_marimo_cell_metadata(cell)[0]


def decode_marimo_cell_metadata(
    cell: lsp.NotebookCell,
) -> tuple[CellId_t | None, dict[str, Any], str]:
    """Decode marimo-specific metadata from lsp.NotebookCell."""
    meta = cast("dict[str, Any]", cell.metadata) if cell.metadata else {}
    cell_id = meta.get("stableId", None)
    config = meta.get("config", {})
    name = meta.get("name", "_")

    return (
        CellId_t(cell_id) if cell_id is not None else None,
        config,
        name,
    )
