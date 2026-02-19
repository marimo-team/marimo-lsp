"""Provide diagnostics for marimo notebooks."""

from __future__ import annotations

import ast
from collections import OrderedDict
from dataclasses import dataclass
from typing import TYPE_CHECKING, Generic, NewType, TypeVar

import lsprotocol.types as lsp
from marimo._ast.compiler import compile_cell
from marimo._messaging.msgspec_encoder import asdict
from marimo._messaging.notification import (
    VariableDeclarationNotification,
    VariablesNotification,
)
from marimo._runtime.dataflow import DirectedGraph
from marimo._types.ids import CellId_t

from marimo_lsp.loggers import get_logger
from marimo_lsp.utils import get_stable_id

if TYPE_CHECKING:
    from marimo._ast.cell import CellImpl
    from pygls.lsp.server import LanguageServer
    from pygls.workspace import Workspace

logger = get_logger()


@dataclass
class VariablePosition:
    """Position of a variable definition in source code."""

    name: str
    line: int  # 1-indexed
    col_start: int
    col_end: int


def get_cell_display_name(cell_id: CellId_t, notebook: lsp.NotebookDocument) -> str:
    """Get a friendly display name for a cell (e.g., 'cell-1', 'cell-2')."""
    for idx, cell in enumerate(notebook.cells, start=1):
        if CellId_t(cell.document) == cell_id:
            return f"cell-{idx}"
    return str(cell_id)  # Fallback to cell_id if not found


T = TypeVar("T")
U = TypeVar("U")

CellDocumentUri = NewType("CellDocumentUri", str)


class LRUCache(Generic[T, U]):
    """A simple LRU (Least Recently Used) cache implementation."""

    def __init__(self, capacity: int) -> None:
        self.cache: OrderedDict[T, U] = OrderedDict()
        self.capacity = capacity

    def get(self, key: T) -> U | None:
        """Retrieve item from cache and mark as recently used."""
        if key not in self.cache:
            return None
        # Move the accessed item to the end (most recently used)
        value = self.cache.pop(key)
        self.cache[key] = value
        return value

    def put(self, key: T, value: U) -> None:
        """Add item to cache, evicting least recently used if necessary."""
        if key in self.cache:
            self.cache.pop(key)  # Remove existing item to update its position
        elif len(self.cache) >= self.capacity:
            # Evict the least recently used item (first item in OrderedDict)
            self.cache.popitem(last=False)
        self.cache[key] = value


class NotebookGraphManager:
    """Manages incremental compilation and graph building for a notebook.

    This class tracks cells and only recompiles when their source text changes,
    avoiding redundant compilation of unchanged cells.
    """

    def __init__(self) -> None:
        """Initialize the manager with empty state."""
        self._cell_sources: dict[CellId_t, str] = {}
        self._compiled_cells: dict[CellId_t, CellImpl] = {}
        self._graph = DirectedGraph()
        self._stale = False
        self.uri_to_cell_id_cache: LRUCache[CellDocumentUri, CellId_t] = LRUCache(
            capacity=1000  # We shouldn't have notebooks larger than this
        )
        self._cached_diagnostics: dict[str, list[lsp.Diagnostic]] | None = None

    def initialize(
        self, server: LanguageServer, notebook: lsp.NotebookDocument
    ) -> None:
        """Build initial graph from all cells in the notebook."""
        for cell in notebook.cells:
            document = server.workspace.text_documents.get(cell.document)
            source = document.source if document else ""
            cell_id = get_stable_id(cell)
            if cell_id:
                self.update_cell(cell_id, source)
            else:
                logger.warning("Could not find cell ID for cell; skipping.")

        # Mark as stale so diagnostics are published on first request
        self._stale = True

    def update_cell(self, cell_id: CellId_t, source: str) -> None:
        """Update a single cell, recompiling only if source changed."""
        # Only recompile if source actually changed
        if self._cell_sources.get(cell_id) == source:
            logger.debug(f"Cell {cell_id} unchanged, skipping recompilation")
            return

        logger.info(f"Updating cell {cell_id}")
        self._cell_sources[cell_id] = source

        # If cell already exists in graph, remove it first
        if cell_id in self._graph.cells:
            self._graph.delete_cell(cell_id)

        try:
            compiled = compile_cell(cell_id=cell_id, code=source)
            self._graph.register_cell(cell_id=cell_id, cell=compiled)
            self._compiled_cells[cell_id] = compiled
            logger.debug(f"Successfully compiled cell {cell_id}")
        except SyntaxError as e:
            # Cell has syntax error, don't add to graph
            logger.warning(f"Syntax error in cell {cell_id}: {e}")
            self._compiled_cells.pop(cell_id, None)

        self._stale = True
        self._cached_diagnostics = None  # Invalidate cache
        logger.debug("Invalidated diagnostic cache for cell update")

    def remove_cell(self, cell_id: CellId_t) -> None:
        """Remove a cell from tracking."""
        self._cell_sources.pop(cell_id, None)
        self._compiled_cells.pop(cell_id, None)
        if cell_id in self._graph.cells:
            self._graph.delete_cell(cell_id)
        self._stale = True
        self._cached_diagnostics = None  # Invalidate cache

    def get_graph(self) -> DirectedGraph:
        """Get the current dependency graph."""
        return self._graph

    def get_compiled_cell(self, cell_id: CellId_t) -> CellImpl | None:
        """Get the compiled cell for a given cell ID."""
        return self._compiled_cells.get(cell_id)

    def get_diagnostics(
        self,
        notebook: lsp.NotebookDocument,
    ) -> dict[str, list[lsp.Diagnostic]]:
        """Get diagnostics for the notebook (cached or freshly computed)."""
        if self._cached_diagnostics is None:
            self._cached_diagnostics = collect_diagnostics(notebook, self)
        return self._cached_diagnostics

    def is_stale(self) -> bool:
        """Check if the graph has changed since last publish."""
        return self._stale

    def mark_clean(self) -> None:
        """Mark the graph as clean after publishing."""
        self._stale = False

    def _remove_cell_document(self, cell: lsp.TextDocumentIdentifier) -> None:
        """Remove a cell from tracking."""
        cell_id = self.uri_to_cell_id_cache.get(CellDocumentUri(cell.uri))
        if not cell_id:
            # Debug instead of warning since can happen during normal operation
            logger.debug(f"Could not find cell ID for URI {cell.uri} (on close)")
        else:
            self.remove_cell(cell_id)

    def _update_cell_document(
        self,
        cell: lsp.VersionedTextDocumentIdentifier | lsp.TextDocumentItem,
        source: str,
    ) -> None:
        """Update a cell from its notebook cell representation."""
        cell_id = self.uri_to_cell_id_cache.get(CellDocumentUri(cell.uri))
        if not cell_id:
            logger.warning(
                f"Could not find cell ID for URI {cell.uri} (on open/update)"
            )
            return
        self.update_cell(cell_id, source)

    def sync_with_notebook_document_change_event(
        self,
        workspace: Workspace,
        change: lsp.NotebookDocumentChangeEvent,
    ) -> None:
        """Sync the graph manager with changes from a notebook document change event."""
        if change.cells is None:
            return

        # Handle cell removals
        self._persist_mapping(change)

        if change.cells.structure and change.cells.structure.did_close:
            for closed_cell in change.cells.structure.did_close:
                self._remove_cell_document(closed_cell)

        # Handle cell additions
        if change.cells.structure and change.cells.structure.did_open:
            for opened_cell in change.cells.structure.did_open:
                self._update_cell_document(opened_cell, opened_cell.text)

        # Handle text content changes
        if change.cells.text_content:
            for text_change in change.cells.text_content:
                document = workspace.text_documents.get(text_change.document.uri)
                if document:
                    self._update_cell_document(text_change.document, document.source)

    def _persist_mapping(self, change: lsp.NotebookDocumentChangeEvent) -> None:
        """Persist mapping from cell URIs to stable IDs for quick lookup."""
        if change.cells is None:
            return

        if change.cells.data:
            for cell in change.cells.data:
                cell_id = get_stable_id(cell)
                if cell_id:
                    self.uri_to_cell_id_cache.put(
                        CellDocumentUri(cell.document), cell_id
                    )
                else:
                    logger.warning(
                        f"Opened cell {cell.document} missing stable ID; cannot map URI."
                    )
        if change.cells.structure and change.cells.structure.array.cells:
            for cell in change.cells.structure.array.cells:
                cell_id = get_stable_id(cell)
                if cell_id:
                    self.uri_to_cell_id_cache.put(
                        CellDocumentUri(cell.document), cell_id
                    )
                else:
                    logger.warning(
                        f"Opened cell {cell.document} missing stable ID; cannot map URI."
                    )


class GraphManagerRegistry:
    """Registry to track NotebookGraphManager instances per notebook URI."""

    def __init__(self) -> None:
        """Initialize the registry with empty state."""
        self._managers: dict[str, NotebookGraphManager] = {}

    def init(
        self,
        notebook: lsp.NotebookDocument,
        server: LanguageServer,
    ) -> NotebookGraphManager:
        """Create and initialize a new graph manager for the given notebook."""
        manager = NotebookGraphManager()
        manager.initialize(server, notebook)
        self._managers[notebook.uri] = manager
        return manager

    def get(self, notebook_uri: str) -> NotebookGraphManager | None:
        """Get the graph manager for the given notebook URI, or None if not found."""
        return self._managers.get(notebook_uri)

    def remove(self, notebook_uri: str) -> None:
        """Remove the graph manager for the given notebook URI."""
        self._managers.pop(notebook_uri, None)


def find_variable_definitions(
    compiled_cell: CellImpl, var_name: str
) -> list[VariablePosition]:
    """Find all positions where a variable is defined (assigned) in the AST."""
    return [
        VariablePosition(
            name=var_name,
            line=node.lineno,
            col_start=node.col_offset,
            col_end=node.end_col_offset or (node.col_offset + len(var_name)),
        )
        for node in ast.walk(compiled_cell.mod)
        if isinstance(node, ast.Name)
        and isinstance(node.ctx, ast.Store)
        and node.id == var_name
    ]


def format_cycle_description(cycle: tuple, notebook: lsp.NotebookDocument) -> str:
    """Format a cycle for display: cell-1 → cell-2 → cell-1."""
    # Each cycle is a tuple of edges, where each edge is (from_cell, to_cell)
    if not cycle:
        return ""

    # Get the cells in order by following the edges
    cells_in_cycle = [cycle[0][0]]  # Start with the first cell
    for edge in cycle:
        # Add the destination of each edge
        cells_in_cycle.append(edge[1])  # noqa: PERF401

    # Convert to display names
    cell_names = [
        get_cell_display_name(cell_id, notebook) for cell_id in cells_in_cycle
    ]

    return " → ".join(cell_names)


def create_cycle_diagnostics(
    notebook: lsp.NotebookDocument,
    graph: DirectedGraph,
) -> dict[str, list[lsp.Diagnostic]]:
    """Create diagnostics for all cells involved in cycles."""
    diagnostics_by_uri: dict[str, list[lsp.Diagnostic]] = {}

    if not graph.cycles:
        logger.debug("No cycles found in graph")
        return diagnostics_by_uri

    logger.info(f"Found {len(graph.cycles)} cycle(s) in graph")

    # Get all cells involved in any cycle
    cells_in_cycles: set[CellId_t] = set()
    for cycle in graph.cycles:
        for edge in cycle:
            cells_in_cycles.add(edge[0])  # from cell
            cells_in_cycles.add(edge[1])  # to cell

    # Create diagnostic for each cell in a cycle
    for cell_id in cells_in_cycles:
        # Find which cycle(s) this cell is in
        relevant_cycles = [
            c for c in graph.cycles if any(cell_id in edge for edge in c)
        ]

        if not relevant_cycles:
            continue

        # Format cycle description
        cycle_desc = format_cycle_description(relevant_cycles[0], notebook)

        # Find the cell document URI
        cell_uri = None
        for cell in notebook.cells:
            if CellId_t(cell.document) == cell_id:
                cell_uri = cell.document
                break

        if cell_uri:
            diagnostic = lsp.Diagnostic(
                range=lsp.Range(
                    start=lsp.Position(line=0, character=0),
                    end=lsp.Position(line=0, character=0),
                ),
                message=f"Cell is part of a dependency cycle: {cycle_desc}",
                severity=lsp.DiagnosticSeverity.Error,
                source="marimo",
                code="cycle-error",
            )
            diagnostics_by_uri.setdefault(cell_uri, []).append(diagnostic)

    return diagnostics_by_uri


def create_multiple_definition_diagnostics(
    notebook: lsp.NotebookDocument,
    graph_manager: NotebookGraphManager,
) -> dict[str, list[lsp.Diagnostic]]:
    """Create diagnostics for multiply-defined variables with red squiggles."""
    diagnostics_by_uri: dict[str, list[lsp.Diagnostic]] = {}

    graph = graph_manager.get_graph()

    # Get all multiply-defined variables
    multiply_defined = graph.get_multiply_defined()

    if not multiply_defined:
        logger.debug("No multiply-defined variables found")
        return diagnostics_by_uri

    logger.info(
        f"Found {len(multiply_defined)} multiply-defined variable(s): {multiply_defined}"
    )

    for var_name in multiply_defined:
        # Get all cells that define this variable
        defining_cells = graph.definitions.get(var_name, set())

        for cell_id in defining_cells:
            # Get compiled cell to find exact position
            compiled = graph_manager.get_compiled_cell(cell_id)
            if not compiled:
                logger.warning(f"No compiled cell found for {cell_id}")
                continue

            # Find positions of this variable definition
            positions = find_variable_definitions(compiled, var_name)

            # Find cell URI
            cell_uri = None
            for cell in notebook.cells:
                if CellId_t(cell.document) == cell_id:
                    cell_uri = cell.document
                    break

            if not cell_uri:
                logger.warning(f"Could not find cell URI for cell_id {cell_id}")
                continue

            # Create diagnostic for each position (red squiggle on variable name)
            other_cells = [c for c in defining_cells if c != cell_id]
            other_cells_names = [
                get_cell_display_name(c, notebook) for c in other_cells
            ]
            other_cells_str = ", ".join(other_cells_names)

            for pos in positions:
                diagnostic = lsp.Diagnostic(
                    range=lsp.Range(
                        start=lsp.Position(line=pos.line - 1, character=pos.col_start),
                        end=lsp.Position(line=pos.line - 1, character=pos.col_end),
                    ),
                    message=f"Variable '{var_name}' is defined in multiple cells (also in: {other_cells_str})",
                    severity=lsp.DiagnosticSeverity.Error,
                    source="marimo",
                    code="multiple-definition",
                    data={
                        "variable": var_name,
                        "cell_id": str(cell_id),
                        "all_cells": [str(c) for c in defining_cells],
                    },
                )
                diagnostics_by_uri.setdefault(cell_uri, []).append(diagnostic)

    return diagnostics_by_uri


def collect_diagnostics(
    notebook: lsp.NotebookDocument,
    graph_manager: NotebookGraphManager,
) -> dict[str, list[lsp.Diagnostic]]:
    """Collect all diagnostics for the notebook.

    Returns a dictionary mapping cell URIs to their list of diagnostics.
    """
    logger.debug(f"Collecting diagnostics for notebook {notebook.uri}")
    all_diagnostics: dict[str, list[lsp.Diagnostic]] = {}

    # Collect cycle diagnostics
    cycle_diags = create_cycle_diagnostics(notebook, graph_manager.get_graph())
    for uri, diags in cycle_diags.items():
        all_diagnostics.setdefault(uri, []).extend(diags)

    # Collect multiple definition diagnostics
    multi_def_diags = create_multiple_definition_diagnostics(notebook, graph_manager)
    for uri, diags in multi_def_diags.items():
        all_diagnostics.setdefault(uri, []).extend(diags)

    logger.debug(f"Collected diagnostics: {len(all_diagnostics)} entries")
    return all_diagnostics


def extract_variables(graph: DirectedGraph) -> VariablesNotification:
    """Extract variable declarations and usages from the directed graph."""
    return VariablesNotification(
        variables=[
            VariableDeclarationNotification(
                name=variable,
                declared_by=list(declared_by),
                used_by=list(graph.get_referring_cells(variable, language="python")),
            )
            for variable, declared_by in graph.definitions.items()
        ]
    )


def publish_diagnostics(
    server: LanguageServer,
    notebook: lsp.NotebookDocument,
    graph: DirectedGraph,
) -> None:
    """Extract and publish various diagnostics from the directed graph."""
    # Publish custom notification for variable ordering (existing behavior)
    variables = extract_variables(graph)
    server.protocol.notify(
        "marimo/operation",
        {"notebookUri": notebook.uri, "operation": asdict(variables)},
    )
