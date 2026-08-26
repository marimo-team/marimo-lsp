# Copyright 2026 Marimo. All rights reserved.

import ast
import inspect
import json

import msgspec
import pytest

from marimo_lsp import protocol


def test_protocol_module_does_not_import_marimo() -> None:
    tree = ast.parse(inspect.getsource(protocol))
    imported = {
        alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.Import)
        for alias in node.names
    } | {
        node.module
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module is not None
    }

    assert not {
        name for name in imported if name == "marimo" or name.startswith("marimo.")
    }


def test_command_is_a_flat_discriminated_union() -> None:
    command = protocol.Execute(
        notebook_uri=protocol.NotebookUri("file:///notebook.py"),
        executable="/venv/bin/python",
        working_directory="/workspace",
        cells=[
            protocol.CellExecution(
                cell_id=protocol.CellId("cell-1"),
                code="answer = 42",
            )
        ],
    )

    encoded = msgspec.json.encode(command)
    assert json.loads(encoded) == {
        "kind": "execute",
        "notebookUri": "file:///notebook.py",
        "executable": "/venv/bin/python",
        "workingDirectory": "/workspace",
        "cells": [{"cellId": "cell-1", "code": "answer = 42"}],
    }
    assert msgspec.json.decode(encoded, type=protocol.Command) == command


def test_command_rejects_unknown_variants() -> None:
    with pytest.raises(msgspec.ValidationError, match="Invalid value"):
        msgspec.json.decode(b'{"kind":"unknown"}', type=protocol.Command)
