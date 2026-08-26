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

type JsonObject = dict[str, object]


class ManagedAppOptions(
    msgspec.Struct,
    rename="camel",
    forbid_unknown_fields=True,
):
    """Source-level app options managed by the extension."""

    auto_download: list[str] = msgspec.field(default_factory=list)


class AppOptions(
    msgspec.Struct,
    rename="camel",
    forbid_unknown_fields=True,
):
    """Managed app options plus an opaque lossless passthrough bag."""

    managed: ManagedAppOptions = msgspec.field(default_factory=ManagedAppOptions)
    passthrough: dict[str, object] = msgspec.field(default_factory=dict)


class SerializedNotebookCellConfig(typing.TypedDict, total=False):
    """Persisted marimo configuration for one notebook cell."""

    column: int | None
    disabled: bool | None
    hide_code: bool | None


class SerializedNotebookCell(typing.TypedDict):
    """One code cell in the serialized notebook format."""

    id: str | None
    code: str | None
    code_hash: str | None
    name: str | None
    config: SerializedNotebookCellConfig


class SerializedNotebookMetadata(typing.TypedDict, total=False):
    """Metadata stored with the serialized notebook."""

    marimo_version: str | None


class SerializedNotebookV1(typing.TypedDict):
    """Owned projection of marimo's version-one notebook document."""

    version: typing.Literal["1"]
    metadata: SerializedNotebookMetadata
    cells: list[SerializedNotebookCell]


class NotebookDocument(
    msgspec.Struct,
    rename="camel",
    forbid_unknown_fields=True,
):
    """Strict notebook data plus source-level application metadata."""

    notebook: SerializedNotebookV1
    app_options: AppOptions = msgspec.field(default_factory=AppOptions)
    header: str | None = None


class CellExecution(msgspec.Struct, rename="camel", forbid_unknown_fields=True):
    """One cell and the exact source to execute for it."""

    cell_id: typing.Annotated[CellId, _brand("CellId")]
    code: str


class ModelUpdateMessage(
    msgspec.Struct,
    tag="update",
    tag_field="method",
    rename="camel",
    forbid_unknown_fields=True,
):
    """State update sent to one widget model."""

    state: JsonObject
    buffer_paths: list[list[str | int]]


class ModelCustomMessage(
    msgspec.Struct,
    tag="custom",
    tag_field="method",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Custom message sent to one widget model."""

    content: object


type ModelMessage = ModelUpdateMessage | ModelCustomMessage


class VenvSource(
    msgspec.Struct,
    tag="venv",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """A concrete environment identified by its Python executable."""

    executable: str


class ScriptSource(
    msgspec.Struct,
    tag="script",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """A PEP 723 environment resolved from the notebook script."""


type PackageSource = VenvSource | ScriptSource


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


class UpdateUiElement(
    msgspec.Struct,
    tag="update-ui-element",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Update one or more UI element values in an exact kernel."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: typing.Annotated[KernelSessionId, _brand("KernelSessionId")]
    object_ids: list[str]
    values: list[object]
    request: JsonObject | None = None
    token: str | None = None


class SetModelValue(
    msgspec.Struct,
    tag="set-model-value",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Update state for one widget model in an exact kernel."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: typing.Annotated[KernelSessionId, _brand("KernelSessionId")]
    model_id: str
    message: ModelMessage
    buffers: list[bytes]
    token: str | None = None


class InvokeFunction(
    msgspec.Struct,
    tag="invoke-function",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Invoke a registered function in an exact kernel."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: typing.Annotated[KernelSessionId, _brand("KernelSessionId")]
    function_call_id: str
    namespace: str
    function_name: str
    args: JsonObject


class Interrupt(
    msgspec.Struct,
    tag="interrupt",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Interrupt an exact kernel or cancel a pending scratch execution."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: (
        typing.Annotated[KernelSessionId, _brand("KernelSessionId")] | None
    ) = None
    run_id: str | None = None


class ListSqlSchemas(
    msgspec.Struct,
    tag="list-sql-schemas",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """List immediate child schemas at a database path."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: typing.Annotated[KernelSessionId, _brand("KernelSessionId")]
    request_id: str
    engine: str
    database: str
    schema_path: list[str] = msgspec.field(default_factory=list)


class ListSqlTables(
    msgspec.Struct,
    tag="list-sql-tables",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """List tables in one database schema."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: typing.Annotated[KernelSessionId, _brand("KernelSessionId")]
    request_id: str
    engine: str
    database: str
    schema: str
    schema_path: list[str] = msgspec.field(default_factory=list)


class SendStdin(
    msgspec.Struct,
    tag="send-stdin",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Respond to a stdin prompt in an exact kernel."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    kernel_session_id: typing.Annotated[KernelSessionId, _brand("KernelSessionId")]
    text: str


class CloseSession(
    msgspec.Struct,
    tag="close-session",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Close the live session for one notebook."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]


class RestartSession(
    msgspec.Struct,
    tag="restart-session",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Restart or restore the live session for one notebook."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    executable: str
    working_directory: str
    create_if_missing: bool = False


class MoveSession(
    msgspec.Struct,
    tag="move-session",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Move a live session after its notebook is renamed."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    new_notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]


class ListSessions(
    msgspec.Struct,
    tag="list-sessions",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """List all live sessions owned by the language server."""


class ShutdownAllSessions(
    msgspec.Struct,
    tag="shutdown-all-sessions",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Close every live session owned by the language server."""


class ExecuteScratchpad(
    msgspec.Struct,
    tag="execute-scratchpad",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Execute transient code against a notebook kernel."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    executable: str
    working_directory: str
    code: str
    run_id: str | None = None


class ListPackages(
    msgspec.Struct,
    tag="list-packages",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """List packages installed in a notebook environment."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    source: PackageSource


class GetDependencyTree(
    msgspec.Struct,
    tag="get-dependency-tree",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Read the dependency tree for a notebook environment."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    source: PackageSource


class Serialize(
    msgspec.Struct,
    tag="serialize",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Serialize notebook data to native marimo Python source."""

    notebook: SerializedNotebookV1
    app_options: AppOptions = msgspec.field(default_factory=AppOptions)
    header: str | None = None


class Deserialize(
    msgspec.Struct,
    tag="deserialize",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Deserialize source into notebook data."""

    source: str


class GetConfiguration(
    msgspec.Struct,
    tag="get-configuration",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Read configuration for one notebook."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]


class UpdateConfiguration(
    msgspec.Struct,
    tag="update-configuration",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Merge a configuration patch for one notebook."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    config: JsonObject


class SetDisplayTheme(
    msgspec.Struct,
    tag="set-display-theme",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Set the display theme for live sessions."""

    theme: typing.Literal["light", "dark"]


class ReadNotebookOutputs(
    msgspec.Struct,
    tag="read-notebook-outputs",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Read outputs without starting a notebook kernel."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    session_cache_path: str | None = None


class ExportHtml(
    msgspec.Struct,
    tag="export-html",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Export one notebook as HTML."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]
    download: bool
    files: list[str]
    include_code: bool
    asset_url: str | None = None


class ExportIpynb(
    msgspec.Struct,
    tag="export-ipynb",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Export one notebook as ipynb JSON."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]


class ExportMarkdown(
    msgspec.Struct,
    tag="export-markdown",
    tag_field="kind",
    rename="camel",
    forbid_unknown_fields=True,
):
    """Export one notebook as Markdown."""

    notebook_uri: typing.Annotated[NotebookUri, _brand("NotebookUri")]


type Command = (
    Execute
    | UpdateUiElement
    | SetModelValue
    | InvokeFunction
    | Interrupt
    | DeleteCell
    | ListSqlSchemas
    | ListSqlTables
    | SendStdin
    | CloseSession
    | RestartSession
    | MoveSession
    | ListSessions
    | ShutdownAllSessions
    | ExecuteScratchpad
    | ListPackages
    | GetDependencyTree
    | Serialize
    | Deserialize
    | GetConfiguration
    | UpdateConfiguration
    | SetDisplayTheme
    | ReadNotebookOutputs
    | ExportHtml
    | ExportIpynb
    | ExportMarkdown
)
"""Commands accepted by the private ``marimo/command`` request."""
