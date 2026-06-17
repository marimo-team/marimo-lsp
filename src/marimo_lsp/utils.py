"""Utility functions for marimo notebooks."""

from __future__ import annotations

from typing import TYPE_CHECKING
from urllib.parse import unquote

import msgspec
from marimo._convert.common.format import (
    DEFAULT_MARKDOWN_PREFIX,
    markdown_to_marimo,
    sql_to_marimo,
)
from marimo._types.ids import CellId_t

from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    DEFAULT_SQL_ENGINE,
    CellLanguageMetadata,
    CellMetadata,
    SqlCellMetadata,
)

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


def decode_cell_metadata(cell: lsp.NotebookCell) -> CellMetadata:
    """Decode marimo-specific metadata from an ``lsp.NotebookCell``.

    ``cell.metadata`` is an untyped ``LSPObject`` (a dict on the wire). We
    parse it into a typed :class:`CellMetadata` so callers earn the type
    instead of asserting it — unknown fields (VS Code's own state, ``options``)
    are ignored and missing fields fall back to the struct defaults.
    """
    return msgspec.convert(cell.metadata or {}, CellMetadata)


def get_stable_id(cell: lsp.NotebookCell) -> CellId_t | None:
    """Get the stable ID of a marimo notebook cell."""
    stable_id = decode_cell_metadata(cell).stable_id
    return CellId_t(stable_id) if stable_id is not None else None


def normalize_cell_code(
    language_id: str,
    source: str,
    language_metadata: CellLanguageMetadata | None,
) -> str:
    """Normalize a smart cell's display source into marimo Python source.

    Markdown and SQL cells sync their *display* form over the notebook
    protocol — raw markdown (``# Header``) and raw SQL (``SELECT ...``) — but
    the kernel, serializer, and dependency graph all expect Python source
    (``mo.md(...)`` / ``_df = mo.sql(...)``). This wraps them back, mirroring
    the frontend ``@marimo-team/smart-cells`` ``transformOut``, reading the
    quote prefix / dataframe name / engine from ``language_metadata`` when the
    client synced it and falling back to marimo's defaults otherwise.

    Python (``python`` / ``mo-python``) cells pass through unchanged.
    """
    if language_id == "markdown":
        markdown = language_metadata.markdown if language_metadata else None
        prefix = markdown.quote_prefix if markdown else DEFAULT_MARKDOWN_PREFIX
        return markdown_to_marimo(source, prefix=prefix)

    if language_id == "sql":
        sql = (language_metadata.sql if language_metadata else None) or (
            SqlCellMetadata()
        )
        engine = sql.engine if sql.engine and sql.engine != DEFAULT_SQL_ENGINE else None
        return sql_to_marimo(
            source,
            table=sql.dataframe_name,
            hide_output=not sql.show_output,
            engine=engine,
        )

    return source
