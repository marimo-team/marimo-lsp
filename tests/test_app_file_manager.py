"""Tests for app_file_manager."""

from __future__ import annotations

from typing import cast
from unittest.mock import MagicMock

import lsprotocol.types as lsp
import pytest

from marimo_lsp.app_file_manager import _find_notebook_document, sync_app_with_workspace


def _lsp_object(d: dict[str, object] | None) -> lsp.LSPObject | None:
    """Cast a plain dict to LSPObject (which is a dict at runtime)."""
    return cast("lsp.LSPObject | None", d)


def _make_workspace(uris: list[str]) -> MagicMock:
    """Create a mock workspace with notebook documents keyed by the given URIs."""
    workspace = MagicMock()
    workspace.notebook_documents = {
        uri: lsp.NotebookDocument(
            uri=uri,
            notebook_type="marimo-notebook",
            version=0,
            cells=[],
        )
        for uri in uris
    }
    return workspace


class TestFindNotebookDocument:
    def test_direct_lookup(self) -> None:
        uri = "file:///home/user/notebook.py"
        ws = _make_workspace([uri])
        doc = _find_notebook_document(ws, uri)
        assert doc.uri == uri

    def test_encoded_lookup_finds_decoded_key(self) -> None:
        """URI with %3A should match a key stored with literal colon."""
        stored = "file:///c:/Users/test/notebook.py"
        lookup = "file:///c%3A/Users/test/notebook.py"
        ws = _make_workspace([stored])
        doc = _find_notebook_document(ws, lookup)
        assert doc.uri == stored

    def test_decoded_lookup_finds_encoded_key(self) -> None:
        """URI with literal colon should match a key stored with %3A."""
        stored = "file:///c%3A/Users/test/notebook.py"
        lookup = "file:///c:/Users/test/notebook.py"
        ws = _make_workspace([stored])
        doc = _find_notebook_document(ws, lookup)
        assert doc.uri == stored

    def test_keyerror_when_no_match(self) -> None:
        ws = _make_workspace(["file:///other/notebook.py"])
        with pytest.raises(KeyError):
            _find_notebook_document(ws, "file:///missing/notebook.py")

    def test_untitled_uri_unaffected(self) -> None:
        uri = "untitled:Untitled-1"
        ws = _make_workspace([uri])
        doc = _find_notebook_document(ws, uri)
        assert doc.uri == uri


def _make_workspace_with_metadata(
    uri: str,
    metadata: dict[str, object] | None,
    cells: list[lsp.NotebookCell] | None = None,
) -> MagicMock:
    """Create a mock workspace with a single notebook document."""
    workspace = MagicMock()
    workspace.notebook_documents = {
        uri: lsp.NotebookDocument(
            uri=uri,
            notebook_type="marimo-notebook",
            version=0,
            cells=cells or [],
            metadata=_lsp_object(metadata),
        )
    }
    workspace.text_documents = {}
    return workspace


class TestSyncAppWithWorkspace:
    def test_extracts_app_options_from_metadata(self) -> None:
        """App config should come from metadata.app.options, not the top-level metadata."""
        uri = "file:///test/notebook.py"
        ws = _make_workspace_with_metadata(
            uri,
            metadata={
                "app": {"options": {"width": "medium", "sql_output": "polars"}},
                "header": {"value": ""},
                "version": "0.19.0",
            },
        )
        app = sync_app_with_workspace(workspace=ws, notebook_uri=uri, app=None)
        assert app.config.width == "medium"
        assert app.config.sql_output == "polars"

    def test_defaults_when_no_app_options(self) -> None:
        """Missing metadata should produce default config."""
        uri = "file:///test/notebook.py"
        ws = _make_workspace_with_metadata(uri, metadata={})
        app = sync_app_with_workspace(workspace=ws, notebook_uri=uri, app=None)
        assert app.config.width == "compact"

    def test_empty_metadata(self) -> None:
        """None metadata should not crash."""
        uri = "file:///test/notebook.py"
        ws = _make_workspace_with_metadata(uri, metadata=None)
        app = sync_app_with_workspace(workspace=ws, notebook_uri=uri, app=None)
        assert app.config.width == "compact"
