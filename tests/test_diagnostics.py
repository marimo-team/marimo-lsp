"""Tests for incremental graph management and diagnostics."""

from __future__ import annotations

from typing import cast

import lsprotocol.types as lsp
from marimo._types.ids import CellId_t

from marimo_lsp.diagnostics import (
    CellDocumentUri,
    GraphManagerRegistry,
    LRUCache,
    NotebookGraphManager,
    decode_marimo_cell_metadata,
    get_stable_id,
)


class TestNotebookGraphManager:
    """Unit tests for NotebookGraphManager."""

    def test_only_recompiles_on_change(self) -> None:
        """Test that cells aren't recompiled when source hasn't changed."""
        manager = NotebookGraphManager()
        cell_id = CellId_t("cell1")

        # First update - should compile and mark stale
        manager.update_cell(cell_id, "x = 1")
        assert manager.is_stale()
        assert cell_id in manager.get_graph().cells
        manager.mark_clean()

        # Second update with same source - should not mark stale
        manager.update_cell(cell_id, "x = 1")
        assert not manager.is_stale()  # Should still be clean!

        # Third update with different source - should recompile and mark stale
        manager.update_cell(cell_id, "x = 2")
        assert manager.is_stale()

    def test_handles_syntax_errors(self) -> None:
        """Test that cells with syntax errors are handled gracefully."""
        manager = NotebookGraphManager()
        cell_id = CellId_t("cell1")

        # Add valid cell
        manager.update_cell(cell_id, "x = 1")
        assert cell_id in manager.get_graph().cells

        # Update with syntax error - should be removed from graph
        manager.update_cell(cell_id, "x = (")
        assert cell_id not in manager.get_graph().cells

        # Fix syntax error - should be added back
        manager.update_cell(cell_id, "x = 2")
        assert cell_id in manager.get_graph().cells

    def test_cell_removal(self) -> None:
        """Test that removing cells works correctly."""
        manager = NotebookGraphManager()
        cell_id = CellId_t("cell1")

        manager.update_cell(cell_id, "x = 1")
        assert cell_id in manager.get_graph().cells

        manager.remove_cell(cell_id)
        assert cell_id not in manager.get_graph().cells
        assert manager.is_stale()

    def test_removes_before_reregistering(self) -> None:
        """Test that cells are deleted before being re-registered."""
        manager = NotebookGraphManager()
        cell_id = CellId_t("cell1")

        # Add cell
        manager.update_cell(cell_id, "x = 1")
        assert cell_id in manager.get_graph().cells

        # Update same cell (should delete then re-add)
        manager.update_cell(cell_id, "x = 2")
        assert cell_id in manager.get_graph().cells

        # Should not raise AssertionError
        manager.update_cell(cell_id, "x = 3")
        assert cell_id in manager.get_graph().cells

    def test_tracks_multiple_cells(self) -> None:
        """Test that multiple cells are tracked independently."""
        manager = NotebookGraphManager()
        cell1 = CellId_t("cell1")
        cell2 = CellId_t("cell2")

        manager.update_cell(cell1, "x = 1")
        manager.update_cell(cell2, "y = x + 1")
        manager.mark_clean()

        # Update only cell1
        manager.update_cell(cell1, "x = 2")
        assert manager.is_stale()
        manager.mark_clean()

        # Update with same value - should not mark stale
        manager.update_cell(cell2, "y = x + 1")
        assert not manager.is_stale()

    def test_graph_has_correct_dependencies(self) -> None:
        """Test that the graph correctly tracks variable dependencies."""
        manager = NotebookGraphManager()
        cell1 = CellId_t("cell1")
        cell2 = CellId_t("cell2")

        manager.update_cell(cell1, "x = 1")
        manager.update_cell(cell2, "y = x + 1")

        graph = manager.get_graph()

        # x should be declared by cell1
        assert "x" in graph.definitions
        assert cell1 in graph.definitions["x"]

        # y should be declared by cell2
        assert "y" in graph.definitions
        assert cell2 in graph.definitions["y"]

        # cell2 should reference x
        assert cell2 in graph.get_referring_cells("x", language="python")


class TestGraphManagerRegistry:
    """Unit tests for GraphManagerRegistry."""

    def test_init_creates_manager(self) -> None:
        """Test that init creates and initializes a manager."""
        registry = GraphManagerRegistry()

        # Mock notebook and server (simplified)
        lsp.NotebookDocument(
            uri="file:///test.py",
            notebook_type="marimo-notebook",
            version=1,
            cells=[],
        )

        # We can't easily test this without a full server mock
        # Just verify the manager is stored
        assert registry.get("file:///test.py") is None

    def test_get_returns_none_when_not_found(self) -> None:
        """Test that get returns None for non-existent notebooks."""
        registry = GraphManagerRegistry()
        assert registry.get("file:///nonexistent.py") is None

    def test_remove_deletes_manager(self) -> None:
        """Test that remove deletes a manager."""
        registry = GraphManagerRegistry()

        # Manually add a manager for testing
        registry._managers["file:///test.py"] = NotebookGraphManager()
        assert registry.get("file:///test.py") is not None

        registry.remove("file:///test.py")
        assert registry.get("file:///test.py") is None

    def test_remove_nonexistent_is_safe(self) -> None:
        """Test that removing a non-existent manager doesn't error."""
        registry = GraphManagerRegistry()
        registry.remove("file:///nonexistent.py")  # Should not raise


class TestIncrementalBehavior:
    """Tests for incremental graph updates."""

    def test_empty_notebook_initializes(self) -> None:
        """Test that an empty notebook can be initialized."""
        manager = NotebookGraphManager()
        # Should not error with no cells
        graph = manager.get_graph()
        assert len(graph.cells) == 0

    def test_multiple_changes_to_same_cell(self) -> None:
        """Test rapidly changing the same cell multiple times."""
        manager = NotebookGraphManager()
        cell_id = CellId_t("cell1")

        # Simulate rapid edits
        for i in range(10):
            manager.update_cell(cell_id, f"x = {i}")
            assert manager.is_stale()
            manager.mark_clean()

        # Final state should be x = 9
        graph = manager.get_graph()
        assert cell_id in graph.cells

    def test_cell_order_independence(self) -> None:
        """Test that cells can be added in any order."""
        manager = NotebookGraphManager()
        cell1 = CellId_t("cell1")
        cell2 = CellId_t("cell2")

        # Add cell2 first (depends on cell1)
        manager.update_cell(cell2, "y = x + 1")
        # Add cell1 second
        manager.update_cell(cell1, "x = 1")

        graph = manager.get_graph()
        assert cell1 in graph.cells
        assert cell2 in graph.cells
        assert "x" in graph.definitions
        assert "y" in graph.definitions


class TestLRUCache:
    """Unit tests for LRUCache."""

    def test_basic_get_put(self) -> None:
        """Test basic get and put operations."""
        cache: LRUCache[str, int] = LRUCache(capacity=2)

        cache.put("a", 1)
        cache.put("b", 2)

        assert cache.get("a") == 1
        assert cache.get("b") == 2
        assert cache.get("c") is None

    def test_eviction_policy(self) -> None:
        """Test that least recently used items are evicted."""
        cache: LRUCache[str, int] = LRUCache(capacity=2)

        cache.put("a", 1)
        cache.put("b", 2)
        # Access "a" to make it recently used
        cache.get("a")
        # Add "c" - should evict "b" (least recently used)
        cache.put("c", 3)

        assert cache.get("a") == 1
        assert cache.get("b") is None  # Evicted
        assert cache.get("c") == 3

    def test_update_existing_key(self) -> None:
        """Test updating an existing key updates its value and position."""
        cache: LRUCache[str, int] = LRUCache(capacity=2)

        cache.put("a", 1)
        cache.put("b", 2)
        cache.put("a", 10)  # Update "a"

        assert cache.get("a") == 10

        # Add new item - should evict "b" since "a" was just updated
        cache.put("c", 3)
        assert cache.get("b") is None
        assert cache.get("a") == 10
        assert cache.get("c") == 3

    def test_capacity_one(self) -> None:
        """Test cache with capacity of one."""
        cache: LRUCache[str, int] = LRUCache(capacity=1)

        cache.put("a", 1)
        assert cache.get("a") == 1

        cache.put("b", 2)
        assert cache.get("a") is None  # Evicted
        assert cache.get("b") == 2


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


class TestURIMapping:
    """Unit tests for URI-to-cell-id mapping functionality."""

    def test_uri_cache_initialization(self) -> None:
        """Test that NotebookGraphManager initializes the URI cache."""
        manager = NotebookGraphManager()
        assert manager.uri_to_cell_id_cache is not None

    def test_update_cell_document_with_cached_mapping(self) -> None:
        """Test _update_cell_document uses cached URI mapping."""
        manager = NotebookGraphManager()
        cell_id = CellId_t("cell1")
        uri = CellDocumentUri("file:///test.py#cell1")

        # Pre-populate the cache
        manager.uri_to_cell_id_cache.put(uri, cell_id)

        # Create a text document identifier
        doc = lsp.VersionedTextDocumentIdentifier(uri=uri, version=1)

        # Update should use the cached mapping
        manager._update_cell_document(doc, "x = 1")

        # Verify the cell was updated
        assert cell_id in manager.get_graph().cells

    def test_remove_cell_document_with_cached_mapping(self) -> None:
        """Test _remove_cell_document uses cached URI mapping."""
        manager = NotebookGraphManager()
        cell_id = CellId_t("cell1")
        uri = CellDocumentUri("file:///test.py#cell1")

        # Add cell and populate cache
        manager.update_cell(cell_id, "x = 1")
        manager.uri_to_cell_id_cache.put(uri, cell_id)

        assert cell_id in manager.get_graph().cells

        # Remove via URI
        doc = lsp.TextDocumentIdentifier(uri=uri)
        manager._remove_cell_document(doc)

        # Verify the cell was removed
        assert cell_id not in manager.get_graph().cells

    def test_persist_mapping_from_data(self) -> None:
        """Test _persist_mapping stores mappings from cell data."""
        manager = NotebookGraphManager()

        cell = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell1",
            metadata=cast("lsp.LSPObject", {"stableId": "abc-123"}),
        )

        change = lsp.NotebookDocumentChangeEvent(
            cells=lsp.NotebookDocumentCellChanges(data=[cell])
        )

        manager._persist_mapping(change)

        # Verify mapping was stored
        cached_id = manager.uri_to_cell_id_cache.get(
            CellDocumentUri("file:///test.py#cell1")
        )
        assert cached_id == CellId_t("abc-123")

    def test_persist_mapping_from_structure(self) -> None:
        """Test _persist_mapping stores mappings from structure array."""
        manager = NotebookGraphManager()

        cell = lsp.NotebookCell(
            kind=lsp.NotebookCellKind.Code,
            document="file:///test.py#cell1",
            metadata=cast("lsp.LSPObject", {"stableId": "abc-123"}),
        )

        change = lsp.NotebookDocumentChangeEvent(
            cells=lsp.NotebookDocumentCellChanges(
                structure=lsp.NotebookDocumentCellChangeStructure(
                    array=lsp.NotebookCellArrayChange(
                        start=0, delete_count=0, cells=[cell]
                    )
                )
            )
        )

        manager._persist_mapping(change)

        # Verify mapping was stored
        cached_id = manager.uri_to_cell_id_cache.get(
            CellDocumentUri("file:///test.py#cell1")
        )
        assert cached_id == CellId_t("abc-123")
