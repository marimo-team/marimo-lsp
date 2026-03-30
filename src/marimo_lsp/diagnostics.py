"""Provide diagnostics for marimo notebooks."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import lsprotocol.types as lsp
from marimo._ast.compiler import compile_cell
from marimo._messaging.msgspec_encoder import asdict
from marimo._messaging.notification import (
    VariableDeclarationNotification,
    VariablesNotification,
)
from marimo._runtime.dataflow import DirectedGraph

from marimo_lsp import _rules
from marimo_lsp.loggers import get_logger
from marimo_lsp.utils import decode_marimo_cell_metadata

logger = get_logger()

if TYPE_CHECKING:
    from marimo._types.ids import CellId_t
    from pygls.lsp.server import LanguageServer

# Lightweight snapshot of the variable dependency structure.
# Maps variable_name → (frozenset of declaring cells, frozenset of using cells).
_VariablesSnapshot = dict[str, tuple[frozenset["CellId_t"], frozenset["CellId_t"]]]

_DEBOUNCE_SECONDS = 0.15


def _snapshot_variables(graph: DirectedGraph) -> _VariablesSnapshot:
    """Create a snapshot of the variable dependency structure for cheap comparison."""
    return {
        variable: (
            frozenset(declared_by),
            frozenset(graph.get_referring_cells(variable, language="python")),
        )
        for variable, declared_by in graph.definitions.items()
    }


def _compute_diagnostics(
    graph: DirectedGraph,
    cell_id_to_uri: dict[CellId_t, str],
    cell_names: dict[CellId_t, str],
    cell_index: dict[CellId_t, int],
) -> dict[str, list[lsp.Diagnostic]]:
    """Compute all diagnostics from the current graph state.

    Returns a dict mapping cell document URIs to their diagnostics.
    """
    return _rules.multiple_definitions(graph, cell_id_to_uri, cell_names, cell_index)


class NotebookGraphUpdater:
    """Debounced graph compilation for a single notebook.

    Rather than compiling on every keystroke, this class schedules compilation
    after a quiet period. When the timer fires (or ``flush()`` is called), it
    reads the latest cell text from the pygls workspace, compiles any cells
    whose source changed, and publishes a ``marimo/operation`` notification if
    the variable dependency structure changed.

    Parameters
    ----------
    server
        The pygls language server, used to read workspace state and send
        notifications.
    notebook_uri
        The URI of the notebook this updater manages.
    """

    def __init__(self, server: LanguageServer, notebook_uri: str) -> None:
        self._server = server
        self._notebook_uri = notebook_uri
        self._cell_sources: dict[CellId_t, str] = {}
        self._graph: DirectedGraph = DirectedGraph()
        self._last_published: _VariablesSnapshot | None = None
        self._debounce_handle: asyncio.TimerHandle | None = None
        self._cached_diagnostics: dict[str, list[lsp.Diagnostic]] = {}

    def schedule(self) -> None:
        """Schedule a debounced recompilation.

        Each call resets the timer. The recompilation runs after
        ``_DEBOUNCE_SECONDS`` of quiet.
        """
        if self._debounce_handle is not None:
            self._debounce_handle.cancel()
        loop = asyncio.get_event_loop()
        self._debounce_handle = loop.call_later(_DEBOUNCE_SECONDS, self._recompile)

    def cancel(self) -> None:
        """Cancel any pending debounce timer without recompiling."""
        if self._debounce_handle is not None:
            self._debounce_handle.cancel()
            self._debounce_handle = None

    def flush(self) -> None:
        """Cancel any pending debounce and recompile immediately."""
        self.cancel()
        self._recompile()

    # -- internal helpers -----------------------------------------------

    def _recompile(self) -> None:  # noqa: C901
        """Read all cells from workspace, compile changed ones, publish if needed."""
        self._debounce_handle = None
        notebook = self._server.workspace.get_notebook_document(
            notebook_uri=self._notebook_uri
        )
        if not notebook:
            return

        cell_id_to_uri: dict[CellId_t, str] = {}
        cell_names: dict[CellId_t, str] = {}
        cell_index: dict[CellId_t, int] = {}

        current_ids: set[CellId_t] = set()
        for idx, cell in enumerate(notebook.cells):
            cell_id, _config, name = decode_marimo_cell_metadata(cell)
            if not cell_id:
                continue
            current_ids.add(cell_id)
            cell_id_to_uri[cell_id] = cell.document
            cell_names[cell_id] = name
            cell_index[cell_id] = idx

            doc = self._server.workspace.text_documents.get(cell.document)
            source = doc.source if doc else ""

            # Skip unchanged cells
            if self._cell_sources.get(cell_id) == source:
                continue

            self._cell_sources[cell_id] = source

            if cell_id in self._graph.cells:
                self._graph.delete_cell(cell_id)

            try:
                compiled = compile_cell(cell_id=cell_id, code=source)
                self._graph.register_cell(cell_id=cell_id, cell=compiled)
            except SyntaxError:
                # Cell has syntax error — don't add to graph
                pass

        # Remove cells no longer in the notebook
        for removed_id in set(self._cell_sources) - current_ids:
            self._cell_sources.pop(removed_id)
            if removed_id in self._graph.cells:
                self._graph.delete_cell(removed_id)

        # Publish variables if the dependency structure changed
        snapshot = _snapshot_variables(self._graph)
        if snapshot != self._last_published:
            self._last_published = snapshot
            _publish_variables(self._server, notebook, self._graph)

        # Recompute and push diagnostics to all affected cells
        new_diagnostics = _compute_diagnostics(
            self._graph, cell_id_to_uri, cell_names, cell_index
        )

        # Publish for every cell that has or previously had diagnostics
        # (empty list clears stale diagnostics)
        for uri in set(new_diagnostics) | set(self._cached_diagnostics):
            self._server.text_document_publish_diagnostics(
                lsp.PublishDiagnosticsParams(
                    uri=uri,
                    diagnostics=new_diagnostics.get(uri, []),
                )
            )

        self._cached_diagnostics = new_diagnostics


class GraphUpdaterRegistry:
    """Registry of ``NotebookGraphUpdater`` instances, one per open notebook."""

    def __init__(self, server: LanguageServer) -> None:
        self._server = server
        self._updaters: dict[str, NotebookGraphUpdater] = {}

    def get_or_create(self, notebook_uri: str) -> NotebookGraphUpdater:
        """Return the updater for *notebook_uri*, creating one if needed."""
        if notebook_uri not in self._updaters:
            self._updaters[notebook_uri] = NotebookGraphUpdater(
                self._server, notebook_uri
            )
        return self._updaters[notebook_uri]

    def remove(self, notebook_uri: str) -> None:
        """Remove the updater for *notebook_uri*, cancelling any pending timer."""
        updater = self._updaters.pop(notebook_uri, None)
        if updater is not None:
            updater.cancel()


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


def _publish_variables(
    server: LanguageServer,
    notebook: lsp.NotebookDocument,
    graph: DirectedGraph,
) -> None:
    """Send a ``marimo/operation`` notification with the current variable state."""
    variables = extract_variables(graph)
    server.protocol.notify(
        "marimo/operation",
        {"notebookUri": notebook.uri, "operation": asdict(variables)},
    )
