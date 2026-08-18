# Copyright 2026 Marimo. All rights reserved.

"""Utility functions for marimo notebooks."""

from __future__ import annotations

import textwrap
from typing import TYPE_CHECKING, cast
from urllib.parse import unquote

import msgspec
from marimo._convert.common.format import (
    DEFAULT_MARKDOWN_PREFIX,
    markdown_to_marimo,
)

from marimo_lsp.loggers import get_logger
from marimo_lsp.models import (
    DEFAULT_SQL_ENGINE,
    CellMetadata,
    CellSourceProjections,
    MarimoNotebookMetadata,
    NotebookDocumentMetadata,
    SqlCellProjection,
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
    parse it into typed, namespaced metadata so callers earn the type instead
    of asserting it. Unknown top-level fields remain outside this projection;
    unknown fields inside an owned namespace are rejected by the model.
    """
    raw = cell.metadata or {}
    raw_dict = cast("dict[str, object]", raw) if isinstance(raw, dict) else {}
    owned = {
        key: raw_dict[key] for key in ("marimo", "marimoRuntime") if key in raw_dict
    }
    return msgspec.convert(owned, CellMetadata)


def decode_notebook_document_metadata(
    notebook: lsp.NotebookDocument,
) -> MarimoNotebookMetadata:
    """Project the owned namespace from untyped LSP notebook metadata.

    Foreign top-level metadata is intentionally left opaque. The selected
    ``marimo`` namespace is validated strictly by ``MarimoNotebookMetadata``.
    """
    raw = notebook.metadata or {}
    raw_dict = cast("dict[str, object]", raw) if isinstance(raw, dict) else {}
    if "marimo" not in raw_dict:
        return MarimoNotebookMetadata()
    envelope = msgspec.convert({"marimo": raw_dict["marimo"]}, NotebookDocumentMetadata)
    return envelope.marimo


def normalize_cell_code(
    language_id: str,
    source: str,
    source_projections: CellSourceProjections,
) -> str:
    """Normalize a smart cell's display source into marimo Python source.

    Markdown and SQL cells sync their *display* form over the notebook
    protocol — raw markdown (``# Header``) and raw SQL (``SELECT ...``) — but
    the kernel, serializer, and dependency graph all expect Python source
    (``mo.md(...)`` / ``_df = mo.sql(...)``). This wraps them back, mirroring
    the frontend ``@marimo-team/smart-cells`` ``transformOut``, reading the
    quote prefix / dataframe name / engine from ``source_projections`` when the
    client synced it and falling back to marimo's defaults otherwise.

    Python (``python`` / ``mo-python``) cells pass through unchanged.
    """
    if language_id == "markdown":
        markdown = source_projections.markdown
        prefix = markdown.quote_prefix if markdown else DEFAULT_MARKDOWN_PREFIX
        return markdown_to_marimo(source, prefix=prefix)

    if language_id == "sql":
        sql = source_projections.sql or SqlCellProjection()
        quote_prefix = sql.quote_prefix
        if '"""' in source and "r" in quote_prefix:
            # Backslashes cannot escape a triple-quote delimiter in a raw
            # string without becoming part of the resulting query. Convert
            # to the equivalent non-raw literal and protect the source's
            # existing backslashes instead. Keep ``f`` so interpolation
            # semantics remain unchanged for ``rf`` / ``fr`` cells.
            quote_prefix = quote_prefix.replace("r", "")
            source = source.replace("\\", "\\\\")
        escaped_source = source.replace('"""', '\\"""')
        terminal_options = [textwrap.indent('"""', "    ")]
        if not sql.show_output:
            terminal_options.append(textwrap.indent("output=False", "    "))
        if sql.engine != DEFAULT_SQL_ENGINE:
            terminal_options.append(textwrap.indent(f"engine={sql.engine}", "    "))

        return "\n".join(
            [
                *sql.comment_lines,
                f"{sql.dataframe_name} = mo.sql(",
                textwrap.indent(f'{quote_prefix}"""', "    "),
                textwrap.indent(escaped_source, "    "),
                ",\n".join(terminal_options),
                ")",
            ]
        )

    return source
