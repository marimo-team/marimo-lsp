"""Diagnostic rules for marimo notebooks."""

from __future__ import annotations

import ast
from typing import TYPE_CHECKING

import lsprotocol.types as lsp

if TYPE_CHECKING:
    from marimo._runtime.dataflow import DirectedGraph
    from marimo._types.ids import CellId_t


def _cell_display_name(
    cell_id: CellId_t,
    cell_names: dict[CellId_t, str],
    cell_index: dict[CellId_t, int],
) -> str:
    """Get a display name for a cell: its marimo name or 'cell N'."""
    name = cell_names.get(cell_id, "_")
    if name and name != "_":
        return name
    idx = cell_index.get(cell_id)
    return f"cell {idx + 1}" if idx is not None else str(cell_id)


def _find_definition_positions(
    mod: ast.Module, name: str
) -> list[tuple[int, int, int]]:
    """Find positions where a variable is defined at module level.

    Returns list of (line_0based, col_start, col_end) tuples.
    """
    positions: list[tuple[int, int, int]] = []
    for node in mod.body:
        _collect_def_positions(node, name, positions)
    return positions


def _collect_def_positions(  # noqa: C901, PLR0912
    node: ast.AST, name: str, out: list[tuple[int, int, int]]
) -> None:
    """Collect definition positions for a name from a single AST statement."""
    match node:
        case ast.FunctionDef(name=n) if n == name:
            col = node.col_offset + len("def ")
            out.append((node.lineno - 1, col, col + len(name)))
        case ast.AsyncFunctionDef(name=n) if n == name:
            col = node.col_offset + len("async def ")
            out.append((node.lineno - 1, col, col + len(name)))
        case ast.ClassDef(name=n) if n == name:
            col = node.col_offset + len("class ")
            out.append((node.lineno - 1, col, col + len(name)))
        case ast.Assign(targets=targets):
            for target in targets:
                _collect_name_stores(target, name, out)
        case ast.AugAssign(target=target):
            _collect_name_stores(target, name, out)
        case ast.AnnAssign(target=target) if target:
            _collect_name_stores(target, name, out)
        case ast.Import(names=aliases) | ast.ImportFrom(names=aliases):
            for alias in aliases:
                bound = alias.asname or alias.name
                if bound == name:
                    line = getattr(alias, "lineno", node.lineno)
                    end_col = getattr(alias, "end_col_offset", None)
                    if end_col is not None:
                        # Highlight just the bound name at the end of the alias span
                        col = end_col - len(bound)
                    else:
                        col = getattr(alias, "col_offset", node.col_offset)
                    out.append((line - 1, col, col + len(bound)))
        case ast.For(target=target) | ast.AsyncFor(target=target):
            _collect_name_stores(target, name, out)
        case ast.With(items=items) | ast.AsyncWith(items=items):
            for item in items:
                if item.optional_vars:
                    _collect_name_stores(item.optional_vars, name, out)


def _collect_name_stores(
    target: ast.AST, name: str, out: list[tuple[int, int, int]]
) -> None:
    """Recursively find Name(Store) nodes matching a name in assignment targets."""
    match target:
        case ast.Name(id=id_, col_offset=col, end_col_offset=end_col) if id_ == name:
            end = end_col or (col + len(name))
            out.append((target.lineno - 1, col, end))
        case ast.Tuple(elts=elts) | ast.List(elts=elts):
            for elt in elts:
                _collect_name_stores(elt, name, out)
        case ast.Starred(value=value):
            _collect_name_stores(value, name, out)


def multiple_definitions(
    graph: DirectedGraph,
    cell_id_to_uri: dict[CellId_t, str],
    cell_names: dict[CellId_t, str],
    cell_index: dict[CellId_t, int],
) -> dict[str, list[lsp.Diagnostic]]:
    """Diagnostic: variables defined in more than one cell."""
    result: dict[str, list[lsp.Diagnostic]] = {}

    for name in graph.get_multiply_defined():
        defining_cells = graph.definitions.get(name, set())
        if len(defining_cells) <= 1:
            continue

        for cell_id in defining_cells:
            uri = cell_id_to_uri.get(cell_id)
            cell = graph.cells.get(cell_id)
            if not uri or not cell:
                continue

            others = sorted(
                (c for c in defining_cells if c != cell_id),
                key=lambda c: cell_index.get(c, float("inf")),
            )
            others_str = ", ".join(
                _cell_display_name(c, cell_names, cell_index) for c in others
            )

            positions = _find_definition_positions(cell.mod, name) if cell.mod else []
            if not positions:
                positions = [(0, 0, 0)]

            for line, col_start, col_end in positions:
                result.setdefault(uri, []).append(
                    lsp.Diagnostic(
                        range=lsp.Range(
                            start=lsp.Position(line=line, character=col_start),
                            end=lsp.Position(line=line, character=col_end),
                        ),
                        message=f"Variable `{name}` is also defined in {others_str}",
                        severity=lsp.DiagnosticSeverity.Error,
                        source="marimo",
                        code="multiple-definitions",
                    ),
                )

    return result


def cycles(  # noqa: C901
    graph: DirectedGraph,
    cell_id_to_uri: dict[CellId_t, str],
    cell_names: dict[CellId_t, str],
    cell_index: dict[CellId_t, int],
) -> dict[str, list[lsp.Diagnostic]]:
    """Diagnostic: cells involved in dependency cycles.

    Highlights the variable definitions in each cell that create outgoing
    edges in the cycle.
    """
    result: dict[str, list[lsp.Diagnostic]] = {}

    for cycle in graph.cycles:
        # For each edge, find the variables that link from_cell → to_cell
        outgoing_vars: dict[CellId_t, set[str]] = {}
        for from_cell, to_cell in cycle:
            if from_cell not in graph.cells or to_cell not in graph.cells:
                continue
            linking = graph.cells[from_cell].defs & graph.cells[to_cell].refs
            linking |= graph.cells[from_cell].refs & graph.cells[to_cell].deleted_refs
            outgoing_vars.setdefault(from_cell, set()).update(linking)

        # Build a human-readable cycle description
        edge_parts: list[str] = []
        for from_cell, _to_cell in cycle:
            name = _cell_display_name(from_cell, cell_names, cell_index)
            vs = outgoing_vars.get(from_cell, set())
            if vs:
                edge_parts.append(f"{name} ({', '.join(sorted(vs))})")
            else:
                edge_parts.append(name)
        cycle_desc = " → ".join(edge_parts)

        # Create a diagnostic on each variable definition that creates an edge
        for cell_id, var_names in outgoing_vars.items():
            uri = cell_id_to_uri.get(cell_id)
            cell = graph.cells.get(cell_id)
            if not uri or not cell:
                continue

            for var_name in sorted(var_names):
                positions = (
                    _find_definition_positions(cell.mod, var_name) if cell.mod else []
                )
                if not positions:
                    positions = [(0, 0, 0)]

                for line, col_start, col_end in positions:
                    result.setdefault(uri, []).append(
                        lsp.Diagnostic(
                            range=lsp.Range(
                                start=lsp.Position(line=line, character=col_start),
                                end=lsp.Position(line=line, character=col_end),
                            ),
                            message=f"Variable `{var_name}` creates a dependency cycle: {cycle_desc}",
                            severity=lsp.DiagnosticSeverity.Error,
                            source="marimo",
                            code="cycle",
                        ),
                    )

    return result
