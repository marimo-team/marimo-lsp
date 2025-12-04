"""Provide diagnostics for marimo notebooks."""

from __future__ import annotations

from collections import OrderedDict
from typing import TYPE_CHECKING, Generic, NewType, TypeVar

from marimo._ast.compiler import compile_cell
from marimo._messaging.msgspec_encoder import asdict
from marimo._messaging.ops import VariableDeclaration, Variables
from marimo._runtime.dataflow import DirectedGraph

from marimo_lsp.loggers import get_logger
from marimo_lsp.utils import get_stable_id

logger = get_logger()

if TYPE_CHECKING:
    import lsprotocol.types as lsp
    from marimo._types.ids import CellId_t
    from pygls.lsp.server import LanguageServer
    from pygls.workspace import Workspace


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
        self._graph: DirectedGraph = DirectedGraph()
        self._stale = False
        self.uri_to_cell_id_cache: LRUCache[CellDocumentUri, CellId_t] = LRUCache(
            capacity=1000  # We shouldn't have notebooks larger than this
        )

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
            return

        self._cell_sources[cell_id] = source

        # If cell already exists in graph, remove it first
        if cell_id in self._graph.cells:
            self._graph.delete_cell(cell_id)

        try:
            compiled = compile_cell(cell_id=cell_id, code=source)
            self._graph.register_cell(cell_id=cell_id, cell=compiled)
        except SyntaxError:
            # Cell has syntax error, don't add to graph
            pass

        self._stale = True

    def remove_cell(self, cell_id: CellId_t) -> None:
        """Remove a cell from tracking."""
        self._cell_sources.pop(cell_id, None)
        if cell_id in self._graph.cells:
            self._graph.delete_cell(cell_id)
        self._stale = True

    def get_graph(self) -> DirectedGraph:
        """Get the current dependency graph."""
        return self._graph

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


def extract_variables(graph: DirectedGraph) -> Variables:
    """Extract variable declarations and usages from the directed graph."""
    return Variables(
        variables=[
            VariableDeclaration(
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
    # Not an actual LSP diagnostic, but a custom notification we use to determine ordering
    # of cells in our extension.
    variables = extract_variables(graph)
    server.protocol.notify(
        "marimo/operation",
        {"notebookUri": notebook.uri, "operation": asdict(variables)},
    )
