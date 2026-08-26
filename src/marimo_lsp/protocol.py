# Copyright 2026 Marimo. All rights reserved.

"""Owned messages exchanged privately between marimo-lsp and the extension.

This module is the source for cross-language type generation. It deliberately
does not import marimo: conversion to and from marimo's runtime types belongs in
an Adapter at the marimo seam.
"""

from __future__ import annotations

import typing

import msgspec

BRAND_METADATA_KEY = "x-marimo-lsp-brand"
"""Metadata key consumed by cross-language protocol generators."""


def _brand(name: str) -> msgspec.Meta:
    return msgspec.Meta(extra_json_schema={BRAND_METADATA_KEY: name})


NotebookUri = typing.NewType("NotebookUri", str)
"""URI identifying one notebook document."""

KernelSessionId = typing.NewType("KernelSessionId", str)
"""Opaque identifier for one exact live kernel session."""

CellId = typing.NewType("CellId", str)
"""Opaque identifier for one notebook cell."""


class CellExecution(msgspec.Struct, rename="camel", forbid_unknown_fields=True):
    """One cell and the exact source to execute for it."""

    cell_id: typing.Annotated[CellId, _brand("CellId")]
    code: str


class Execute(
    msgspec.Struct,
    tag="execute",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Execute a batch of notebook cells, starting its kernel if necessary."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    executable: str
    working_directory: str
    cells: list[CellExecution]


class DeleteCell(
    msgspec.Struct,
    tag="delete-cell",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Remove one cell from the exact live kernel that owns it."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: typing.Annotated[KernelSessionId, _brand("KernelSessionId")]
    cell_id: typing.Annotated[CellId, _brand("CellId")]


type Command = Execute | DeleteCell
"""Commands accepted by the private ``marimo/command`` request."""
