# Copyright 2026 Marimo. All rights reserved.

"""Marimo models rewritten in attrs for `pygls` compatibility."""

from __future__ import annotations

import typing

import marimo._server.models.models as core
import msgspec

# These stay runtime imports (noqa: TC002) even though they only appear in
# annotations: msgspec resolves the stringified annotations when the structs
# are first encoded/inspected, which fails under TYPE_CHECKING-only imports.
from marimo._ast.app_config import _AppConfig
from marimo._config.config import MarimoConfig  # noqa: TC002
from marimo._convert.common.format import DEFAULT_MARKDOWN_PREFIX
from marimo._runtime.packages.package_manager import PackageDescription  # noqa: TC002
from marimo._schemas.notebook import (
    NotebookCellConfig,
    NotebookMetadata,
    NotebookV1,
)
from marimo._server.models.packages import DependencyTreeNode  # noqa: TC002

# NOTE: the generic structs below use the legacy TypeVar spelling (noqa: UP046)
# because msgspec's annotation resolver cannot see PEP 695 type parameters —
# `NotebookCommand[X]` raises `NameError: name 'T' is not defined` at decode.
T = typing.TypeVar("T", bound=msgspec.Struct)

# Sentinel the frontend `@marimo-team/smart-cells` SQL parser writes into
# `sourceProjections.sql.engine` for the implicit default engine. We must not
# emit `engine=__marimo_duckdb` when round-tripping these cells.
DEFAULT_SQL_ENGINE = "__marimo_duckdb"


class NotebookCommand(msgspec.Struct, typing.Generic[T], rename="camel"):  # noqa: UP046
    """Wraps a marimo command with its target notebook context.

    Associates any marimo command/request with the specific notebook
    it should operate on, enabling proper routing in multi-notebook
    environments.
    """

    notebook_uri: str
    """The URI of the notebook."""

    inner: T
    """The wrapped marimo command to execute."""


class SessionCommand(NotebookCommand[T]):
    """A notebook command that is further routed to a specific runtime/session."""

    executable: str
    """The target environment Python executable."""


class VenvSource(msgspec.Struct, tag="venv", tag_field="kind", rename="camel"):
    """The notebook's environment is a concrete venv with a known python executable."""

    executable: str
    """Path to the python binary inside the venv."""


class ScriptSource(msgspec.Struct, tag="script", tag_field="kind", rename="camel"):
    """The notebook's environment is a PEP 723 sandbox script.

    The server resolves the script filename from the notebook URI; `uv`
    derives the venv from the script's inline metadata.
    """


PackageSource = VenvSource | ScriptSource
"""Discriminated union of environment sources for package endpoints."""


class PackageCommand(NotebookCommand[T]):
    """A notebook command that describes its python environment via a `PackageSource`.

    Distinct from `SessionCommand`: package endpoints don't talk to a live
    marimo kernel — they shell out to `uv` — and sandbox notebooks have no
    pre-resolved python executable for the client to send.
    """

    source: PackageSource
    """How to resolve the notebook's python environment."""


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
        default_factory=NotebookCellConfig,
        name="options",
    )
    """The marimo `NotebookCellConfig`.

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

    app_config: _AppConfig = msgspec.field(default_factory=_AppConfig)
    header: str | None = None
    notebook_metadata: NotebookMetadata = msgspec.field(default_factory=dict)


class NotebookDocumentMetadata(
    msgspec.Struct, rename="camel", forbid_unknown_fields=True
):
    """Canonical metadata envelope on an LSP notebook document."""

    __preserve_unknown_fields__: typing.ClassVar[bool] = True

    marimo: MarimoNotebookMetadata


class NotebookDocument(msgspec.Struct, rename="camel"):
    """Strict JSON notebook data plus source-level application metadata."""

    notebook: NotebookV1
    app_config: _AppConfig = msgspec.field(default_factory=_AppConfig)
    header: str | None = None


class DeserializeRequest(msgspec.Struct, rename="camel"):
    """
    A request to deserialize Python source to notebook format.

    Contains the source code to be parsed.
    """

    source: str
    """The Python source code to deserialize."""


class ConvertRequest(msgspec.Struct, rename="camel"):
    """A request to convert a file source a marimo notebook."""

    uri: str
    """The identifier for the text document to convert"""


class InterruptRequest(msgspec.Struct, rename="camel"):
    """A request to interrupt the kernel execution."""


class ListPackagesRequest(msgspec.Struct, rename="camel"):
    """A request to list installed packages in the kernel environment."""


class DependencyTreeRequest(msgspec.Struct, rename="camel"):
    """A request to get the dependency tree of installed packages."""


class GetConfigurationRequest(msgspec.Struct, rename="camel"):
    """A request to get the current configuration."""


class CloseSessionRequest(msgspec.Struct, rename="camel"):
    """A request to close the current session."""


class ExportAsIpynbRequest(msgspec.Struct, rename="camel"):
    """A request to export the notebook as ipynb."""


class ExecuteScratchRequest(msgspec.Struct, rename="camel"):
    """Execute arbitrary Python code outside the dependency graph."""

    code: str
    """The Python code to execute."""

    run_id: str | None = None
    """Optional correlation id, echoed back on the kernel's ``completed-run``
    ``marimo/operation`` notification (consumed client-side in KernelManager).

    Lets a caller wait for *its* completion (including any code-mode cascade)
    rather than the scratch cell's idle.
    """


class UpdateConfigurationRequest(msgspec.Struct, rename="camel"):
    """A request to update the user configuration."""

    config: dict[str, object]
    """The partial configuration to merge with the current config."""


class SetDisplayThemeRequest(msgspec.Struct, rename="camel"):
    """A request to set the display theme without persisting to disk."""

    theme: typing.Literal["light", "dark"]
    """The theme to set ('light' or 'dark')."""


class ApiRequest(msgspec.Struct, rename="camel"):
    """A unified API request for all marimo internal methods."""

    method: str
    """The API method to call (e.g., 'run', 'interrupt', 'serialize')."""

    params: dict[str, object]
    """The parameters for the method."""


class ListPackagesResponse(msgspec.Struct, rename="camel"):
    """Response for ``get-package-list``."""

    packages: list[PackageDescription]
    """Installed packages in the notebook's environment."""


class DependencyTreeResponse(msgspec.Struct, rename="camel"):
    """Response for ``get-dependency-tree``."""

    tree: DependencyTreeNode | None = None
    """The environment's dependency tree, or ``None`` when unresolvable."""


class SerializeResponse(msgspec.Struct, rename="camel"):
    """Response for ``serialize``."""

    source: str
    """The notebook rendered as Python source."""


class GetConfigurationResponse(msgspec.Struct, rename="camel"):
    """Response for ``get-configuration``."""

    config: MarimoConfig
    """The resolved marimo configuration (defaults when no session exists)."""


class SetDisplayThemeResponse(msgspec.Struct, rename="camel"):
    """Response for ``set-display-theme``."""

    success: bool


ExecuteCellsRequest = core.ExecuteCellsRequest
UpdateUIElementRequest = core.UpdateUIElementRequest
ModelRequest = core.ModelRequest
DeleteCellRequest = core.DeleteCellRequest
StdinRequest = core.StdinRequest
