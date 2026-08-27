# Copyright 2026 Marimo. All rights reserved.

"""Marimo models rewritten in attrs for `pygls` compatibility."""

from __future__ import annotations

import typing

import marimo._server.models.models as core
import msgspec

# These stay runtime imports (noqa: TC002) even though they only appear in
# annotations: msgspec resolves the stringified annotations when the structs
# are first encoded/inspected, which fails under TYPE_CHECKING-only imports.
from marimo._config.config import MarimoConfig  # noqa: TC002
from marimo._convert.common.format import DEFAULT_MARKDOWN_PREFIX
from marimo._messaging.notification import (  # noqa: TC002
    CellNotification,
    NotificationMessage,
    VariablesNotification,
)
from marimo._runtime.packages.package_manager import PackageDescription  # noqa: TC002
from marimo._server.models.packages import DependencyTreeNode  # noqa: TC002
from marimo._types.ids import SessionId  # noqa: TC002

from marimo_lsp.protocol import AppOptions, NotebookCellConfig, NotebookMetadata

# Sentinel the frontend `@marimo-team/smart-cells` SQL parser writes into
# `sourceProjections.sql.engine` for the implicit default engine. We must not
# emit `engine=__marimo_duckdb` when round-tripping these cells.
DEFAULT_SQL_ENGINE = "__marimo_duckdb"


class KernelNotification(msgspec.Struct, rename="camel"):
    """A notification emitted by one exact live kernel."""

    notebook_uri: str
    session_id: SessionId
    notification: NotificationMessage


class DocumentAnalysis(msgspec.Struct, rename="camel"):
    """Analysis derived from a notebook document without a live kernel."""

    notebook_uri: str
    analysis: VariablesNotification


type SmartCellQuotePrefix = typing.Literal["", "f", "r", "fr", "rf"]


class MarkdownCellProjection(
    msgspec.Struct, rename="camel", forbid_unknown_fields=True
):
    """Projection state for displaying a Python markdown cell."""

    quote_prefix: SmartCellQuotePrefix = DEFAULT_MARKDOWN_PREFIX
    """The string-literal prefix used to wrap the markdown (e.g. ``r``)."""


class SqlCellProjection(msgspec.Struct, rename="camel", forbid_unknown_fields=True):
    """Projection state for displaying a Python SQL cell."""

    dataframe_name: str = "_df"
    """The variable the query result is bound to (``_df = mo.sql(...)``)."""

    quote_prefix: SmartCellQuotePrefix = "f"
    """The string-literal prefix used by the smart-cell projection."""

    comment_lines: list[str] = msgspec.field(default_factory=list)
    """Comments retained by the smart-cell projection when wrapping SQL."""

    show_output: bool = True
    """Whether the query result is displayed (``output=False`` when ``False``)."""

    engine: str = DEFAULT_SQL_ENGINE
    """The SQL engine variable, or the implicit-default sentinel."""


class CellSourceProjections(msgspec.Struct, rename="camel", forbid_unknown_fields=True):
    """Retained source projections for reversible cell-language changes.

    Both projections may coexist. The cell's current language selects which
    projection is active; retaining the other restores its settings if the
    user switches the cell back later.
    """

    markdown: MarkdownCellProjection | None = None
    sql: SqlCellProjection | None = None


class MarimoCellMetadata(msgspec.Struct, rename="camel", forbid_unknown_fields=True):
    """Persisted marimo cell metadata used to serialize Python source."""

    name: str = "_"
    """The marimo cell name."""

    config: NotebookCellConfig = msgspec.field(
        default_factory=dict,
        name="options",
    )
    """The owned notebook cell configuration.

    Synced on the wire as ``options`` (VS Code's notebook cell config key); we
    expose it as ``config`` to match marimo's downstream vocabulary
    (``CellConfig``, ``with_data(configs=...)``).
    """

    source_projections: CellSourceProjections = msgspec.field(
        default_factory=CellSourceProjections
    )
    """Projection history retained across markdown, SQL, and Python views."""


type CellRuntimeState = typing.Literal["idle", "queued", "running", "stale"]


class MarimoCellRuntimeMetadata(
    msgspec.Struct, rename="camel", forbid_unknown_fields=True
):
    """Transient per-open cell metadata shared with the LSP server."""

    stable_id: str | None = None
    """Ephemeral per-open cell identifier; the marimo `CellId_t`."""

    state: CellRuntimeState | None = None
    """Transient execution state projected by the TypeScript client."""


class CellMetadata(msgspec.Struct, rename="camel", forbid_unknown_fields=True):
    """Namespaced metadata synchronized on an LSP notebook cell."""

    __preserve_unknown_fields__: typing.ClassVar[bool] = True

    marimo: MarimoCellMetadata = msgspec.field(default_factory=MarimoCellMetadata)
    marimo_runtime: MarimoCellRuntimeMetadata = msgspec.field(
        default_factory=MarimoCellRuntimeMetadata
    )


class MarimoNotebookMetadata(
    msgspec.Struct, rename="camel", forbid_unknown_fields=True
):
    """Persisted marimo-owned metadata on an LSP notebook document."""

    app_options: AppOptions = msgspec.field(default_factory=AppOptions)
    header: str | None = None
    notebook_metadata: NotebookMetadata = msgspec.field(default_factory=dict)


class NotebookDocumentMetadata(
    msgspec.Struct, rename="camel", forbid_unknown_fields=True
):
    """Canonical metadata envelope on an LSP notebook document."""

    __preserve_unknown_fields__: typing.ClassVar[bool] = True

    marimo: MarimoNotebookMetadata


class ConvertRequest(msgspec.Struct, rename="camel"):
    """A request to convert a file source a marimo notebook."""

    uri: str
    """The identifier for the text document to convert"""


class SessionInfo(msgspec.Struct, rename="camel", frozen=True):
    """User-facing state for one live kernel session."""

    session_id: SessionId
    notebook_uri: str
    filename: str | None
    executable: str
    working_directory: str
    started_at: float
    status: typing.Literal["idle", "running"]
    attached: bool


class ListSessionsResponse(msgspec.Struct, rename="camel"):
    """Snapshot of all live sessions owned by this language server."""

    sessions: list[SessionInfo]


class ListPackagesResponse(msgspec.Struct, rename="camel"):
    """Response for ``list-packages``."""

    packages: list[PackageDescription]
    """Installed packages in the notebook's environment."""


class DependencyTreeResponse(msgspec.Struct, rename="camel"):
    """Response for ``get-dependency-tree``."""

    tree: DependencyTreeNode | None = None
    """The environment's dependency tree, or ``None`` when unresolvable."""


class GetConfigurationResponse(msgspec.Struct, rename="camel"):
    """Response for ``get-configuration``."""

    config: MarimoConfig
    """The resolved marimo configuration (defaults when no session exists)."""


class SetDisplayThemeResponse(msgspec.Struct, rename="camel"):
    """Response for ``set-display-theme``."""

    success: bool


class LiveCellReplay(
    msgspec.Struct,
    tag="live",
    tag_field="kind",
    rename="camel",
    frozen=True,
):
    """One cell projected from an authoritative live SessionView."""

    notification: CellNotification
    executed_source: str | None


class SavedCellReplay(
    msgspec.Struct,
    tag="saved",
    tag_field="kind",
    rename="camel",
    frozen=True,
):
    """One cell restored from a compatible saved-session sidecar."""

    notification: CellNotification


type CellOutputReplay = LiveCellReplay | SavedCellReplay


class ReadNotebookOutputsResponse(msgspec.Struct, rename="camel", frozen=True):
    """Cell outputs replayed from live memory or a saved-session sidecar."""

    cells: list[CellOutputReplay]


ExecuteCellsRequest = core.ExecuteCellsRequest
UpdateUIElementRequest = core.UpdateUIElementRequest
ModelRequest = core.ModelRequest
DeleteCellRequest = core.DeleteCellRequest
ListSQLSchemasRequest = core.ListSQLSchemasRequest
ListSQLTablesRequest = core.ListSQLTablesRequest
StdinRequest = core.StdinRequest
