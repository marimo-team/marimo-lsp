"""Tests for diagnostic rules."""

from __future__ import annotations

from typing import TYPE_CHECKING

from inline_snapshot import snapshot
from marimo._ast.compiler import compile_cell
from marimo._runtime.dataflow import DirectedGraph
from marimo._types.ids import CellId_t

from marimo_lsp._rules import DiagnosticRule, cycles, multiple_definitions

if TYPE_CHECKING:
    import lsprotocol.types as lsp


def _render_diagnostics(
    cells: dict[str, str],
    diagnostics: dict[str, list[lsp.Diagnostic]],
) -> str:
    """Render diagnostics onto source code for easy visual verification.

    Each cell's source is printed with ^^^ markers under the diagnostic ranges.

    Example output::

        -- cell 1 --
        x = 1
        ^ multiple-definitions: Variable `x` is also defined in cell 2
        -- cell 2 --
        x = 2
        ^ multiple-definitions: Variable `x` is also defined in cell 1
    """
    lines: list[str] = []
    for idx, (uri, source) in enumerate(cells.items()):
        lines.append(f"-- cell {idx + 1} --")
        source_lines = source.splitlines() or [""]
        cell_diags = diagnostics.get(uri, [])

        # Group diagnostics by line
        diags_by_line: dict[int, list[lsp.Diagnostic]] = {}
        for d in cell_diags:
            diags_by_line.setdefault(d.range.start.line, []).append(d)

        for line_no, text in enumerate(source_lines):
            lines.append(text)
            for d in diags_by_line.get(line_no, []):
                col_start = d.range.start.character
                col_end = d.range.end.character
                width = max(col_end - col_start, 1)
                marker = " " * col_start + "^" * width
                lines.append(f"{marker} {d.code}: {d.message}")

    return "\n".join(lines)


def _build_graph(
    cell_sources: list[str],
) -> tuple[
    DirectedGraph,
    dict[CellId_t, str],
    dict[CellId_t, str],
    dict[CellId_t, int],
    dict[str, str],
]:
    """Build a graph from cell sources.

    Returns (graph, cell_id_to_uri, cell_names, cell_index, cells_by_uri).
    """
    graph = DirectedGraph()
    cell_id_to_uri: dict[CellId_t, str] = {}
    cell_names: dict[CellId_t, str] = {}
    cell_index: dict[CellId_t, int] = {}
    cells_by_uri: dict[str, str] = {}

    for idx, source in enumerate(cell_sources):
        cell_id = CellId_t(f"cell{idx}")
        uri = f"file:///test.py#cell-{cell_id}"

        cell_id_to_uri[cell_id] = uri
        cell_names[cell_id] = "_"
        cell_index[cell_id] = idx
        cells_by_uri[uri] = source

        try:
            compiled = compile_cell(cell_id=cell_id, code=source)
            graph.register_cell(cell_id=cell_id, cell=compiled)
        except SyntaxError:
            pass

    return graph, cell_id_to_uri, cell_names, cell_index, cells_by_uri


def _run_rule(
    cell_sources: list[str],
    rule: DiagnosticRule,
) -> tuple[dict[str, str], dict[str, list[lsp.Diagnostic]]]:
    """Build a graph and run a rule. Returns (cells_by_uri, diagnostics)."""
    graph, cell_id_to_uri, cell_names, cell_index, cells_by_uri = _build_graph(
        cell_sources
    )
    diags = rule(graph, cell_id_to_uri, cell_names, cell_index)
    return cells_by_uri, diags


def _run_multiple_definitions(
    cell_sources: list[str],
) -> tuple[dict[str, str], dict[str, list[lsp.Diagnostic]]]:
    return _run_rule(cell_sources, multiple_definitions)


def _run_cycles(
    cell_sources: list[str],
) -> tuple[dict[str, str], dict[str, list[lsp.Diagnostic]]]:
    return _run_rule(cell_sources, cycles)


class TestMultipleDefinitions:
    def test_simple_duplicate(self) -> None:
        cells, diags = _run_multiple_definitions(["x = 1", "x = 2"])
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
x = 1
^ multiple-definitions: Variable `x` is also defined in cell 2
-- cell 2 --
x = 2
^ multiple-definitions: Variable `x` is also defined in cell 1\
"""
        )

    def test_no_duplicates(self) -> None:
        cells, diags = _run_multiple_definitions(["x = 1", "y = 2"])
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
x = 1
-- cell 2 --
y = 2\
"""
        )

    def test_underscore_vars_excluded(self) -> None:
        """Underscore-prefixed variables are cell-local in marimo."""
        cells, diags = _run_multiple_definitions(["_x = 1", "_x = 2"])
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
_x = 1
-- cell 2 --
_x = 2\
"""
        )

    def test_function_def(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["def foo():\n    pass", "def foo():\n    return 1"]
        )
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
def foo():
    ^^^ multiple-definitions: Variable `foo` is also defined in cell 2
    pass
-- cell 2 --
def foo():
    ^^^ multiple-definitions: Variable `foo` is also defined in cell 1
    return 1\
"""
        )

    def test_class_def(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["class Foo:\n    pass", "class Foo:\n    x = 1"]
        )
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
class Foo:
      ^^^ multiple-definitions: Variable `Foo` is also defined in cell 2
    pass
-- cell 2 --
class Foo:
      ^^^ multiple-definitions: Variable `Foo` is also defined in cell 1
    x = 1\
"""
        )

    def test_import(self) -> None:
        cells, diags = _run_multiple_definitions(["import os", "import os"])
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
import os
       ^^ multiple-definitions: Variable `os` is also defined in cell 2
-- cell 2 --
import os
       ^^ multiple-definitions: Variable `os` is also defined in cell 1\
"""
        )

    def test_three_cells(self) -> None:
        cells, diags = _run_multiple_definitions(["x = 1", "x = 2", "x = 3"])
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
x = 1
^ multiple-definitions: Variable `x` is also defined in cell 2, cell 3
-- cell 2 --
x = 2
^ multiple-definitions: Variable `x` is also defined in cell 1, cell 3
-- cell 3 --
x = 3
^ multiple-definitions: Variable `x` is also defined in cell 1, cell 2\
"""
        )

    def test_tuple_unpacking(self) -> None:
        cells, diags = _run_multiple_definitions(["b, a = 1, 2", "a = 3"])
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
b, a = 1, 2
   ^ multiple-definitions: Variable `a` is also defined in cell 2
-- cell 2 --
a = 3
^ multiple-definitions: Variable `a` is also defined in cell 1\
"""
        )

    def test_async_function_def(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["async def fetch(): pass", "async def fetch(): return 1"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
async def fetch(): pass
          ^^^^^ multiple-definitions: Variable `fetch` is also defined in cell 2
-- cell 2 --
async def fetch(): return 1
          ^^^^^ multiple-definitions: Variable `fetch` is also defined in cell 1\
""")

    def test_import_from(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["from math import sin", "from numpy import sin"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
from math import sin
                 ^^^ multiple-definitions: Variable `sin` is also defined in cell 2
-- cell 2 --
from numpy import sin
                  ^^^ multiple-definitions: Variable `sin` is also defined in cell 1\
""")

    def test_import_as(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["import numpy as np", "import pandas as np"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
import numpy as np
                ^^ multiple-definitions: Variable `np` is also defined in cell 2
-- cell 2 --
import pandas as np
                 ^^ multiple-definitions: Variable `np` is also defined in cell 1\
""")

    def test_from_import_as(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["from math import sin as trig", "from numpy import cos as trig"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
from math import sin as trig
                        ^^^^ multiple-definitions: Variable `trig` is also defined in cell 2
-- cell 2 --
from numpy import cos as trig
                         ^^^^ multiple-definitions: Variable `trig` is also defined in cell 1\
""")

    def test_augmented_assignment(self) -> None:
        cells, diags = _run_multiple_definitions(["x = 1", "x += 1"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x = 1
^ multiple-definitions: Variable `x` is also defined in cell 2
-- cell 2 --
x += 1
^ multiple-definitions: Variable `x` is also defined in cell 1\
""")

    def test_annotated_assignment(self) -> None:
        cells, diags = _run_multiple_definitions(["x: int = 1", "x: int = 2"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x: int = 1
^ multiple-definitions: Variable `x` is also defined in cell 2
-- cell 2 --
x: int = 2
^ multiple-definitions: Variable `x` is also defined in cell 1\
""")

    def test_for_loop_target(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["for i in range(10):\n    pass", "i = 42"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
for i in range(10):
    ^ multiple-definitions: Variable `i` is also defined in cell 2
    pass
-- cell 2 --
i = 42
^ multiple-definitions: Variable `i` is also defined in cell 1\
""")

    def test_async_for_target(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["async for item in aiter:\n    pass", "item = 42"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
async for item in aiter:
          ^^^^ multiple-definitions: Variable `item` is also defined in cell 2
    pass
-- cell 2 --
item = 42
^^^^ multiple-definitions: Variable `item` is also defined in cell 1\
""")

    def test_with_target(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["with open('f') as f:\n    pass", "f = 42"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
with open('f') as f:
                  ^ multiple-definitions: Variable `f` is also defined in cell 2
    pass
-- cell 2 --
f = 42
^ multiple-definitions: Variable `f` is also defined in cell 1\
""")

    def test_async_with_target(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["async with aopen('f') as f:\n    pass", "f = 42"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
async with aopen('f') as f:
                         ^ multiple-definitions: Variable `f` is also defined in cell 2
    pass
-- cell 2 --
f = 42
^ multiple-definitions: Variable `f` is also defined in cell 1\
""")

    def test_star_unpacking(self) -> None:
        cells, diags = _run_multiple_definitions(["a, *b, c = [1, 2, 3, 4]", "b = 99"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
a, *b, c = [1, 2, 3, 4]
    ^ multiple-definitions: Variable `b` is also defined in cell 2
-- cell 2 --
b = 99
^ multiple-definitions: Variable `b` is also defined in cell 1\
""")

    def test_nested_tuple_unpacking(self) -> None:
        cells, diags = _run_multiple_definitions(
            ["(x, (y, z)) = (1, (2, 3))", "y = 99"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
(x, (y, z)) = (1, (2, 3))
     ^ multiple-definitions: Variable `y` is also defined in cell 2
-- cell 2 --
y = 99
^ multiple-definitions: Variable `y` is also defined in cell 1\
""")

    def test_multiple_variables_one_cell(self) -> None:
        """Two variables in one cell conflict with two different cells."""
        cells, diags = _run_multiple_definitions(["x = 1\ny = 2", "x = 10", "y = 20"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x = 1
^ multiple-definitions: Variable `x` is also defined in cell 2
y = 2
^ multiple-definitions: Variable `y` is also defined in cell 3
-- cell 2 --
x = 10
^ multiple-definitions: Variable `x` is also defined in cell 1
-- cell 3 --
y = 20
^ multiple-definitions: Variable `y` is also defined in cell 1\
""")

    def test_syntax_error_cell_ignored(self) -> None:
        """A cell with a syntax error doesn't produce diagnostics."""
        cells, diags = _run_multiple_definitions(["x = 1", "x = ("])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x = 1
-- cell 2 --
x = (\
""")

    def test_named_cells(self) -> None:
        """Named cells should appear by name in the message."""
        graph = DirectedGraph()
        cell_id_to_uri: dict[CellId_t, str] = {}
        cell_names: dict[CellId_t, str] = {}
        cell_index: dict[CellId_t, int] = {}

        for idx, (source, name) in enumerate(
            [("x = 1", "setup"), ("x = 2", "compute")]
        ):
            cid = CellId_t(f"cell{idx}")
            uri = f"file:///test.py#cell-{cid}"
            cell_id_to_uri[cid] = uri
            cell_names[cid] = name
            cell_index[cid] = idx
            compiled = compile_cell(cell_id=cid, code=source)
            graph.register_cell(cell_id=cid, cell=compiled)

        diags = multiple_definitions(graph, cell_id_to_uri, cell_names, cell_index)
        cells = {
            cell_id_to_uri[CellId_t("cell0")]: "x = 1",
            cell_id_to_uri[CellId_t("cell1")]: "x = 2",
        }
        assert _render_diagnostics(cells, diags) == snapshot(
            """\
-- cell 1 --
x = 1
^ multiple-definitions: Variable `x` is also defined in compute
-- cell 2 --
x = 2
^ multiple-definitions: Variable `x` is also defined in setup\
"""
        )


class TestCycles:
    def test_simple_cycle(self) -> None:
        """A → B → A: cell 1 defines x used by cell 2, cell 2 defines y used by cell 1."""
        cells, diags = _run_cycles(["x = 1\nz = y", "y = 1\nw = x"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x = 1
^ cycle: Variable `x` creates a dependency cycle: cell 2 (y) → cell 1 (x)
z = y
-- cell 2 --
y = 1
^ cycle: Variable `y` creates a dependency cycle: cell 2 (y) → cell 1 (x)
w = x\
""")

    def test_no_cycle(self) -> None:
        """Linear dependency: no cycle."""
        cells, diags = _run_cycles(["x = 1", "y = x + 1"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x = 1
-- cell 2 --
y = x + 1\
""")

    def test_three_cell_cycle(self) -> None:
        """A → B → C → A."""
        cells, diags = _run_cycles(
            ["a = 1\nuse_c = c", "b = 1\nuse_a = a", "c = 1\nuse_b = b"]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
a = 1
^ cycle: Variable `a` creates a dependency cycle: cell 3 (c) → cell 1 (a) → cell 2 (b)
use_c = c
-- cell 2 --
b = 1
^ cycle: Variable `b` creates a dependency cycle: cell 3 (c) → cell 1 (a) → cell 2 (b)
use_a = a
-- cell 3 --
c = 1
^ cycle: Variable `c` creates a dependency cycle: cell 3 (c) → cell 1 (a) → cell 2 (b)
use_b = b\
""")

    def test_self_cycle_via_del(self) -> None:
        """A cell that deletes a variable defined by another cell creates an edge."""
        cells, diags = _run_cycles(["x = 1\ndel y", "y = 1\ndel x"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x = 1
^ cycle: Variable `x` creates a dependency cycle: cell 2 (y) → cell 1 (x)
del y
-- cell 2 --
y = 1
^ cycle: Variable `y` creates a dependency cycle: cell 2 (y) → cell 1 (x)
del x\
""")

    def test_cycle_highlights_definitions_not_references(self) -> None:
        """The squiggle should be on the definition (x = 1), not the reference (y)."""
        cells, diags = _run_cycles(["x = 1\nprint(y)", "y = 1\nprint(x)"])
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
x = 1
^ cycle: Variable `x` creates a dependency cycle: cell 2 (y) → cell 1 (x)
print(y)
-- cell 2 --
y = 1
^ cycle: Variable `y` creates a dependency cycle: cell 2 (y) → cell 1 (x)
print(x)\
""")

    def test_cycle_with_function_defs(self) -> None:
        """Cycle via function definitions."""
        cells, diags = _run_cycles(
            [
                "def foo():\n    return bar()",
                "def bar():\n    return foo()",
            ]
        )
        assert _render_diagnostics(cells, diags) == snapshot("""\
-- cell 1 --
def foo():
    ^^^ cycle: Variable `foo` creates a dependency cycle: cell 2 (bar) → cell 1 (foo)
    return bar()
-- cell 2 --
def bar():
    ^^^ cycle: Variable `bar` creates a dependency cycle: cell 2 (bar) → cell 1 (foo)
    return foo()\
""")
