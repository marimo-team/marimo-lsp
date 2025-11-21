"""Provide diagnostics for marimo notebooks."""

from __future__ import annotations

from typing import TYPE_CHECKING

from marimo._ast.compiler import compile_cell
from marimo._messaging.msgspec_encoder import asdict
from marimo._messaging.ops import VariableDeclaration, Variables
from marimo._runtime.dataflow import DirectedGraph
from marimo._types.ids import CellId_t

if TYPE_CHECKING:
    import lsprotocol.types as lsp
    from pygls.lsp.server import LanguageServer


def build_graph(
    server: LanguageServer, notebook: lsp.NotebookDocument
) -> DirectedGraph:
    """Build a directed graph representing cell dependencies in the notebook."""
    graph = DirectedGraph()
    for cell in notebook.cells:
        try:
            # Extract cell ID from document URI fragment (e.g., "file:///test.py#cell1" -> "cell1")
            cell_id = CellId_t(cell.document)
            document_uri = server.workspace.text_documents.get(cell.document)
            graph.register_cell(
                cell_id,
                compile_cell(
                    cell_id=cell_id,
                    code=document_uri.source if document_uri else "",
                ),
            )
        except SyntaxError:  # noqa: PERF203
            continue
    return graph


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
