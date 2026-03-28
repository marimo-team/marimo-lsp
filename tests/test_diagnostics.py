"""Tests for debounced graph compilation and variable publishing."""

from __future__ import annotations

from typing import cast
from unittest.mock import MagicMock, patch

import lsprotocol.types as lsp
from marimo._types.ids import CellId_t

from marimo_lsp.diagnostics import (
    GraphUpdaterRegistry,
    NotebookGraphUpdater,
    _snapshot_variables,
)
from marimo_lsp.utils import decode_marimo_cell_metadata, get_stable_id


def _make_server(
    cells: list[tuple[str, str]],
    notebook_uri: str = "file:///test.py",
) -> MagicMock:
    """Create a mock server whose workspace contains the given cells.

    Parameters
    ----------
    cells
        List of (stable_id, source) tuples.
    notebook_uri
        URI of the notebook.
    """
    server = MagicMock()

    lsp_cells = []
    text_docs: dict[str, MagicMock] = {}

    for stable_id, source in cells:
        cell_uri = f"{notebook_uri}#cell-{stable_id}"
        lsp_cells.append(
            lsp.NotebookCell(
                kind=lsp.NotebookCellKind.Code,
                document=cell_uri,
                metadata=cast("lsp.LSPObject", {"stableId": stable_id}),
            )
        )
        doc_mock = MagicMock()
        doc_mock.source = source
        text_docs[cell_uri] = doc_mock

    notebook = lsp.NotebookDocument(
        uri=notebook_uri,
        notebook_type="marimo-notebook",
        version=1,
        cells=lsp_cells,
    )
    server.workspace.get_notebook_document.return_value = notebook
    server.workspace.text_documents = text_docs
    return server


class TestNotebookGraphUpdater:
    """Tests for NotebookGraphUpdater."""

    def test_flush_compiles_and_publishes(self) -> None:
        """flush() should compile all cells and publish variables."""
        server = _make_server(
            [
                ("cell1", "x = 1"),
                ("cell2", "y = x + 1"),
            ]
        )
        updater = NotebookGraphUpdater(server, "file:///test.py")

        updater.flush()

        server.protocol.notify.assert_called_once()
        call_args = server.protocol.notify.call_args
        assert call_args[0][0] == "marimo/operation"

    def test_flush_skips_publish_when_variables_unchanged(self) -> None:
        """Second flush with same sources should not publish again."""
        server = _make_server([("cell1", "x = 1")])
        updater = NotebookGraphUpdater(server, "file:///test.py")

        updater.flush()
        assert server.protocol.notify.call_count == 1

        # Same sources — should not publish again
        updater.flush()
        assert server.protocol.notify.call_count == 1

    def test_flush_publishes_when_variables_change(self) -> None:
        """Changing a cell's source to alter variables should trigger publish."""
        server = _make_server([("cell1", "x = 1")])
        updater = NotebookGraphUpdater(server, "file:///test.py")
        updater.flush()
        assert server.protocol.notify.call_count == 1

        # Change cell source to introduce a new variable
        server.workspace.text_documents[
            "file:///test.py#cell-cell1"
        ].source = "x = 1\ny = 2"
        updater.flush()
        assert server.protocol.notify.call_count == 2

    def test_flush_skips_publish_when_source_changes_but_variables_dont(self) -> None:
        """Changing source without altering variables should not publish."""
        server = _make_server([("cell1", "x = 1")])
        updater = NotebookGraphUpdater(server, "file:///test.py")
        updater.flush()
        assert server.protocol.notify.call_count == 1

        # Change value but not variable structure
        server.workspace.text_documents["file:///test.py#cell-cell1"].source = "x = 2"
        updater.flush()
        assert server.protocol.notify.call_count == 1

    def test_handles_syntax_errors(self) -> None:
        """Cells with syntax errors should not crash the updater."""
        server = _make_server([("cell1", "x = (")])
        updater = NotebookGraphUpdater(server, "file:///test.py")

        # Should not raise
        updater.flush()

        # Fix the syntax error
        server.workspace.text_documents["file:///test.py#cell-cell1"].source = "x = 1"
        updater.flush()

        # Should have published (new variable x)
        assert server.protocol.notify.call_count >= 1

    def test_removed_cells_cleaned_up(self) -> None:
        """Cells removed from notebook should be cleaned from the graph."""
        server = _make_server(
            [
                ("cell1", "x = 1"),
                ("cell2", "y = x + 1"),
            ]
        )
        updater = NotebookGraphUpdater(server, "file:///test.py")
        updater.flush()

        # Remove cell2 from the notebook
        notebook = server.workspace.get_notebook_document.return_value
        notebook.cells = [notebook.cells[0]]
        del server.workspace.text_documents["file:///test.py#cell-cell2"]

        updater.flush()

        # Variable y should no longer be published
        last_call = server.protocol.notify.call_args
        operation = last_call[0][1]["operation"]
        var_names = [v["name"] for v in operation["variables"]]
        assert "y" not in var_names
        assert "x" in var_names

    def test_cells_without_stable_id_skipped(self) -> None:
        """Cells missing stableId metadata should be silently skipped."""
        server = MagicMock()

        cell_with_id = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell-1",
            metadata=cast("lsp.LSPObject", {"stableId": "cell1"}),
        )
        cell_without_id = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell-2",
            metadata=cast("lsp.LSPObject", {}),
        )

        notebook = lsp.NotebookDocument(
            uri="file:///test.py",
            notebook_type="marimo-notebook",
            version=1,
            cells=[cell_with_id, cell_without_id],
        )
        server.workspace.get_notebook_document.return_value = notebook

        doc1 = MagicMock()
        doc1.source = "x = 1"
        doc2 = MagicMock()
        doc2.source = "# no id"
        server.workspace.text_documents = {
            "file:///test.py#cell-1": doc1,
            "file:///test.py#cell-2": doc2,
        }

        updater = NotebookGraphUpdater(server, "file:///test.py")
        updater.flush()  # Should not raise

    def test_missing_notebook_is_noop(self) -> None:
        """flush() when notebook not found in workspace should be a no-op."""
        server = MagicMock()
        server.workspace.get_notebook_document.return_value = None

        updater = NotebookGraphUpdater(server, "file:///missing.py")
        updater.flush()  # Should not raise

        server.protocol.notify.assert_not_called()

    def test_dependency_tracking(self) -> None:
        """Variables operation should include correct declared_by and used_by."""
        server = _make_server(
            [
                ("cell1", "x = 1"),
                ("cell2", "y = x + 1"),
            ]
        )
        updater = NotebookGraphUpdater(server, "file:///test.py")
        updater.flush()

        call_args = server.protocol.notify.call_args
        operation = call_args[0][1]["operation"]
        variables = {v["name"]: v for v in operation["variables"]}

        assert "x" in variables
        assert CellId_t("cell1") in variables["x"]["declared_by"]
        assert CellId_t("cell2") in variables["x"]["used_by"]

    def test_schedule_sets_debounce_handle(self) -> None:
        """schedule() should set a debounce handle."""
        server = _make_server([("cell1", "x = 1")])
        updater = NotebookGraphUpdater(server, "file:///test.py")

        with patch("marimo_lsp.diagnostics.asyncio") as mock_asyncio:
            mock_loop = MagicMock()
            mock_asyncio.get_event_loop.return_value = mock_loop

            updater.schedule()

            mock_loop.call_later.assert_called_once()
            assert mock_loop.call_later.call_args[0][0] == 0.15

    def test_flush_cancels_pending_schedule(self) -> None:
        """flush() should cancel any pending debounce timer."""
        server = _make_server([("cell1", "x = 1")])
        updater = NotebookGraphUpdater(server, "file:///test.py")

        # Simulate a pending timer
        mock_handle = MagicMock()
        updater._debounce_handle = mock_handle

        updater.flush()

        mock_handle.cancel.assert_called_once()
        assert updater._debounce_handle is None


class TestGraphUpdaterRegistry:
    """Tests for GraphUpdaterRegistry."""

    def test_get_or_create_returns_same_instance(self) -> None:
        """get_or_create should return the same updater for the same URI."""
        server = MagicMock()
        registry = GraphUpdaterRegistry(server)

        u1 = registry.get_or_create("file:///test.py")
        u2 = registry.get_or_create("file:///test.py")
        assert u1 is u2

    def test_get_or_create_different_uris(self) -> None:
        """get_or_create should return different updaters for different URIs."""
        server = MagicMock()
        registry = GraphUpdaterRegistry(server)

        u1 = registry.get_or_create("file:///a.py")
        u2 = registry.get_or_create("file:///b.py")
        assert u1 is not u2

    def test_remove_cancels_timer(self) -> None:
        """remove() should cancel any pending debounce timer."""
        server = MagicMock()
        registry = GraphUpdaterRegistry(server)

        updater = registry.get_or_create("file:///test.py")

        with patch.object(updater, "cancel") as mock_cancel:
            registry.remove("file:///test.py")
            mock_cancel.assert_called_once()

        # New get_or_create should return a fresh instance
        assert registry.get_or_create("file:///test.py") is not updater

    def test_remove_nonexistent_is_safe(self) -> None:
        """Removing a non-existent notebook should not raise."""
        server = MagicMock()
        registry = GraphUpdaterRegistry(server)
        registry.remove("file:///nonexistent.py")  # Should not raise


class TestSnapshotVariables:
    """Tests for the _snapshot_variables helper."""

    def test_empty_graph(self) -> None:
        """Empty graph should produce empty snapshot."""
        from marimo._runtime.dataflow import DirectedGraph

        graph = DirectedGraph()
        snapshot = _snapshot_variables(graph)
        assert snapshot == {}

    def test_snapshot_captures_dependencies(self) -> None:
        """Snapshot should capture declared_by and used_by as frozensets."""
        from marimo._ast.compiler import compile_cell
        from marimo._runtime.dataflow import DirectedGraph

        graph = DirectedGraph()
        cell1 = CellId_t("cell1")
        cell2 = CellId_t("cell2")

        compiled1 = compile_cell(cell_id=cell1, code="x = 1")
        graph.register_cell(cell_id=cell1, cell=compiled1)

        compiled2 = compile_cell(cell_id=cell2, code="y = x + 1")
        graph.register_cell(cell_id=cell2, cell=compiled2)

        snapshot = _snapshot_variables(graph)

        assert "x" in snapshot
        declared_by, used_by = snapshot["x"]
        assert cell1 in declared_by
        assert cell2 in used_by


class TestCellMetadataHelpers:
    """Unit tests for cell metadata helper functions."""

    def test_get_stable_id_with_id(self) -> None:
        """Test get_stable_id returns the stable ID when present."""
        cell = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell1",
            metadata=cast("lsp.LSPObject", {"stableId": "abc-123"}),
        )

        stable_id = get_stable_id(cell)
        assert stable_id == CellId_t("abc-123")

    def test_get_stable_id_without_id(self) -> None:
        """Test get_stable_id returns None when stable ID is missing."""
        cell = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell1",
            metadata=cast("lsp.LSPObject", {}),
        )

        stable_id = get_stable_id(cell)
        assert stable_id is None

    def test_get_stable_id_no_metadata(self) -> None:
        """Test get_stable_id returns None when metadata is missing."""
        cell = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell1",
        )

        stable_id = get_stable_id(cell)
        assert stable_id is None

    def test_decode_marimo_cell_metadata_complete(self) -> None:
        """Test decode_marimo_cell_metadata with all metadata."""
        cell = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell1",
            metadata=cast(
                "lsp.LSPObject",
                {
                    "stableId": "abc-123",
                    "config": {"disabled": True},
                    "name": "my_cell",
                },
            ),
        )

        cell_id, config, name = decode_marimo_cell_metadata(cell)
        assert cell_id == CellId_t("abc-123")
        assert config == {"disabled": True}
        assert name == "my_cell"

    def test_decode_marimo_cell_metadata_defaults(self) -> None:
        """Test decode_marimo_cell_metadata with missing fields."""
        cell = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell1",
            metadata=cast("lsp.LSPObject", {}),
        )

        cell_id, config, name = decode_marimo_cell_metadata(cell)
        assert cell_id is None
        assert config == {}
        assert name == "_"
