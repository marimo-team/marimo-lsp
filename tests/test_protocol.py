# Copyright 2026 Marimo. All rights reserved.

import ast
import inspect
import json
from pathlib import Path

import msgspec
import msgspec.inspect as msgspec_inspect
import pytest

from marimo_lsp import protocol

COMMAND_PROTOCOL = Path(__file__).parent / "fixtures" / "command_protocol.json"


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


def test_command_protocol_compatibility_corpus() -> None:
    corpus = json.loads(COMMAND_PROTOCOL.read_text())
    commands = [
        msgspec.convert(value, type=protocol.Command) for value in corpus["valid"]
    ]
    command_type = msgspec_inspect.type_info(protocol.Command)

    assert isinstance(command_type, msgspec_inspect.UnionType)
    assert {type(command) for command in commands} == {
        variant.cls
        for variant in command_type.types
        if isinstance(variant, msgspec_inspect.StructType)
    }
    assert [msgspec.to_builtins(command) for command in commands] == corpus["valid"]

    for value in corpus["invalid"]:
        with pytest.raises(msgspec.ValidationError):
            msgspec.convert(value, type=protocol.Command)
