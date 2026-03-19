"""Tests for app_file_manager URI normalization."""

from __future__ import annotations

from unittest.mock import MagicMock

import lsprotocol.types as lsp
import pytest

from marimo_lsp.app_file_manager import _find_notebook_document


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
