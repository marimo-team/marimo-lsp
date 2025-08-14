"""Handler for LSP completions."""

from __future__ import annotations

import typing

import lsprotocol.types as lsp
from pygls.uris import to_fs_path

if typing.TYPE_CHECKING:
    from pygls.lsp.server import LanguageServer


def get_completions(
    ls: LanguageServer, params: lsp.CompletionParams
) -> list[lsp.CompletionItem]:
    """Handle LSP completions."""
    completions: list[lsp.CompletionItem] = []

    filename = to_fs_path(params.text_document.uri)
    if not filename or not filename.endswith(".py"):
        return completions

    text_document = ls.workspace.get_text_document(params.text_document.uri)
    if not text_document or "app = marimo.App(" not in text_document.source:
        return completions

    lines = text_document.source.split("\n")
    current_line_idx = params.position.line
    if current_line_idx < len(lines):
        current_line = lines[current_line_idx]
        line_prefix = current_line[: params.position.character]

        if line_prefix.strip() in ["@", "@a", "@ap", "@app"]:
            completions.append(
                lsp.CompletionItem(
                    label="@app.cell",
                    kind=lsp.CompletionItemKind.Snippet,
                    detail="Insert a new marimo cell",
                    documentation="Creates a new marimo cell",
                    insert_text="@app.cell\ndef _():\n    ${2:}\n    return",
                    insert_text_format=lsp.InsertTextFormat.Snippet,
                )
            )

    return completions
