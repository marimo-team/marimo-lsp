"""Utility functions for marimo notebooks."""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, cast

from marimo._types.ids import CellId_t

from marimo_lsp.loggers import get_logger

logger = get_logger()

if TYPE_CHECKING:
    import lsprotocol.types as lsp


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
