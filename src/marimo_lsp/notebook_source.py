# Copyright 2026 Marimo. All rights reserved.

"""Adapt owned notebook documents to and from native marimo Python source."""

from __future__ import annotations

import ast
import keyword
from dataclasses import replace

import msgspec
from marimo._ast.codegen import generate_filecontents_from_ir
from marimo._ast.compiler import module_compile
from marimo._ast.parse import MarimoFileError
from marimo._ast.parse import parse_notebook as parse_marimo_notebook
from marimo._convert.non_marimo_python_script import (
    convert_non_marimo_python_script_to_notebook_ir,
)
from marimo._convert.notebook import convert_from_ir_to_notebook_v1
from marimo._schemas.serialization import (
    EMPTY_NOTEBOOK_SERIALIZATION,
    AppInstantiation,
    CellDef,
    Header,
    NotebookSerializationV1,
)

from marimo_lsp import protocol
from marimo_lsp.app_options import (
    MARIMO_APP_CONFIG_FIELDS,
    app_options_from_source,
    merge_app_options,
)


def print_notebook(document: protocol.NotebookDocument) -> protocol.PrintNotebookResult:
    """Print an owned notebook document through marimo's source generator."""
    ir = _document_to_ir(document)
    return protocol.PrintNotebookResult(source=_print_ir(ir))


def parse_notebook(source: str) -> protocol.ParseNotebookResult:
    """Parse native marimo source into an owned notebook document."""
    try:
        ir = parse_marimo_notebook(source, filepath="notebook.py") or replace(
            EMPTY_NOTEBOOK_SERIALIZATION,
            filename="notebook.py",
        )
    except SyntaxError as error:
        return _classify_convertible(source, syntax_error=error)
    except MarimoFileError as error:
        if str(error) != "`marimo.App` definition expected.":
            raise
        return _classify_convertible(source)

    if not ir.valid:
        return _classify_convertible(source)

    notebook = msgspec.to_builtins(convert_from_ir_to_notebook_v1(ir))
    if not isinstance(notebook, dict):
        msg = "marimo notebook conversion did not produce an object"
        raise TypeError(msg)
    document = msgspec.convert(
        {
            **notebook,
            "appOptions": app_options_from_source(source, ir.app.options),
            "header": ir.header.value if ir.header is not None else None,
        },
        type=protocol.NotebookDocument,
    )
    return protocol.ParseNotebookSuccess(document=document)


def _document_to_ir(
    document: protocol.NotebookDocument,
) -> NotebookSerializationV1:
    """Adapt an owned notebook document to marimo's source-level IR."""
    return NotebookSerializationV1(
        app=AppInstantiation(options=merge_app_options(document.app_options)),
        header=Header(value=document.header) if document.header is not None else None,
        version=None,
        cells=[
            CellDef(
                code=cell.get("code", "") or "",
                name=cell.get("name", "") or "",
                options={
                    "column": cell.get("config", {}).get("column"),
                    "disabled": cell.get("config", {}).get("disabled", False),
                    "hide_code": cell.get("config", {}).get("hide_code", False),
                },
            )
            for cell in document.cells
        ],
        violations=[],
        valid=True,
    )


def _print_ir(ir: NotebookSerializationV1) -> str:
    """Print marimo IR while preserving options its generator does not know."""
    unknown_options = {
        name: value
        for name, value in ir.app.options.items()
        if name not in MARIMO_APP_CONFIG_FIELDS
    }
    printable_ir = replace(
        ir,
        app=AppInstantiation(
            options={
                name: value
                for name, value in ir.app.options.items()
                if name in MARIMO_APP_CONFIG_FIELDS
            }
        ),
    )
    source = generate_filecontents_from_ir(printable_ir)
    return _restore_unknown_app_options(source, unknown_options)


def _restore_unknown_app_options(source: str, options: dict[str, object]) -> str:
    """Restore opaque options dropped by marimo's current source generator."""
    if not options:
        return source

    rendered_options: list[str] = []
    for name, value in options.items():
        if not name.isidentifier() or keyword.iskeyword(name):
            msg = f"App config key cannot be represented as a keyword: {name!r}"
            raise ValueError(msg)
        rendered = repr(value)
        try:
            ast.literal_eval(rendered)
        except (ValueError, SyntaxError) as error:
            msg = f"App config value is not a Python literal: {name!r}={rendered}"
            raise ValueError(msg) from error
        rendered_options.append(f"{name}={rendered}")

    tree = ast.parse(source)
    call = next(
        (
            node.value
            for node in tree.body
            if isinstance(node, ast.Assign)
            and any(
                isinstance(target, ast.Name) and target.id == "app"
                for target in node.targets
            )
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and isinstance(node.value.func.value, ast.Name)
            and node.value.func.value.id == "marimo"
            and node.value.func.attr == "App"
        ),
        None,
    )
    if call is None or call.end_lineno is None or call.end_col_offset is None:
        msg = "Generated notebook did not contain marimo.App(...)"
        raise ValueError(msg)

    lines = source.splitlines(keepends=True)

    def offset(line_number: int, byte_column: int) -> int:
        line = lines[line_number - 1]
        char_column = len(line.encode()[:byte_column].decode())
        return sum(map(len, lines[: line_number - 1])) + char_column

    end = offset(call.end_lineno, call.end_col_offset)
    separator = ", " if call.args or call.keywords else ""
    insertion = f"{separator}{', '.join(rendered_options)}"
    return f"{source[: end - 1]}{insertion}{source[end - 1 :]}"


def _syntax_error_position(
    source: str, error: SyntaxError
) -> tuple[int | None, int | None]:
    if error.filename == "notebook.py":
        return error.lineno, error.offset

    # Some failures in marimo's cell fallback are relative to the extracted
    # cell body. Only translate them when the offending line is unambiguous.
    if error.text is None:
        return None, None
    error_line = error.text.rstrip("\r\n")
    matches = [
        line_number
        for line_number, source_line in enumerate(source.splitlines(), start=1)
        if source_line == error_line
    ]
    if len(matches) != 1:
        return None, None
    return matches[0], error.offset


def _classify_convertible(
    source: str,
    syntax_error: SyntaxError | None = None,
) -> protocol.ParseNotebookConvertible | protocol.ParseNotebookInvalidSyntax:
    try:
        # Use the same compiler as marimo cells so valid notebook constructs,
        # notably top-level await, are not rejected as ordinary scripts.
        module_compile(source)
    except SyntaxError as error:
        if "# %%" in source:
            try:
                # Jupytext magics are not Python syntax until the percent
                # converter rewrites them. Validate the conversion we actually
                # offer instead of guessing from the original source.
                converted = convert_non_marimo_python_script_to_notebook_ir(source)
                for cell in converted.cells:
                    module_compile(cell.code)
            except SyntaxError:
                pass
            else:
                return protocol.ParseNotebookConvertible()

        failure = syntax_error or error
        line, column = _syntax_error_position(source, failure)
        return protocol.ParseNotebookInvalidSyntax(line=line, column=column)
    return protocol.ParseNotebookConvertible()
