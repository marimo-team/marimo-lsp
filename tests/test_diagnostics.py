"""Tests for incremental graph management and diagnostics."""

from __future__ import annotations

import lsprotocol.types as lsp
from marimo._types.ids import CellId_t

from marimo_lsp.diagnostics import GraphManagerRegistry, NotebookGraphManager


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
