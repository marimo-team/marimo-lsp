"""Marimo models rewritten in attrs for `pygls` compatibility."""

from __future__ import annotations

import typing

import marimo._server.models.models as core
import msgspec
from marimo._convert.common.format import DEFAULT_MARKDOWN_PREFIX

T = typing.TypeVar("T", bound=msgspec.Struct)

# Sentinel the frontend `@marimo-team/smart-cells` SQL parser writes into
# `languageMetadata.sql.engine` for the implicit default engine. We must not
# emit `engine=__marimo_duckdb` when round-tripping these cells.
DEFAULT_SQL_ENGINE = "__marimo_duckdb"


class NotebookCommand(msgspec.Struct, typing.Generic[T], rename="camel"):
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


# TODO: hand-mirrored from `extension/src/schemas/CellMetadata.ts`; nothing keeps
# them in sync. Drive both from one source of truth (codegen / shared schema).
class MarkdownCellMetadata(msgspec.Struct, rename="camel"):
    """Smart-cell metadata for a markdown cell (mirrors the frontend shape)."""

    quote_prefix: str = DEFAULT_MARKDOWN_PREFIX
    """The string-literal prefix used to wrap the markdown (e.g. ``r``)."""


class SqlCellMetadata(msgspec.Struct, rename="camel"):
    """Smart-cell metadata for a SQL cell (mirrors the frontend shape)."""

    dataframe_name: str = "_df"
    """The variable the query result is bound to (``_df = mo.sql(...)``)."""

    show_output: bool = True
    """Whether the query result is displayed (``output=False`` when ``False``)."""

    engine: str | None = None
    """The SQL engine variable, or ``None`` for the implicit default."""


class CellLanguageMetadata(msgspec.Struct, rename="camel"):
    """Language-specific smart-cell metadata needed to re-wrap display source.

    Only one of these is set, matching the cell's language. Absent when the
    client didn't sync it, in which case the per-language defaults apply.
    """

    markdown: MarkdownCellMetadata | None = None
    sql: SqlCellMetadata | None = None


class CellMetadata(msgspec.Struct, rename="camel"):
    """marimo-specific fields synced on a VS Code notebook cell's metadata."""

    stable_id: str | None = None
    """Ephemeral per-open cell identifier; the marimo `CellId_t`."""

    name: str = "_"
    """The marimo cell name."""

    config: dict[str, typing.Any] = msgspec.field(default_factory=dict)
    """The marimo `CellConfig` as a plain dict."""

    language_metadata: CellLanguageMetadata | None = None
    """Smart-cell metadata for markdown/SQL cells; absent for Python cells."""


class SerializeRequest(msgspec.Struct, rename="camel"):
    """
    A request to serialize a notebook to Python source.

    Contains the notebook data to be serialized.
    """

    notebook: dict[str, typing.Any]
    """The notebook data in marimo's internal format."""


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

    config: dict[str, typing.Any]
    """The partial configuration to merge with the current config."""


class SetDisplayThemeRequest(msgspec.Struct, rename="camel"):
    """A request to set the display theme without persisting to disk."""

    theme: str
    """The theme to set ('light' or 'dark')."""


class ApiRequest(msgspec.Struct, rename="camel"):
    """A unified API request for all marimo internal methods."""

    method: str
    """The API method to call (e.g., 'run', 'interrupt', 'serialize')."""

    params: dict[str, typing.Any]
    """The parameters for the method."""


ExecuteCellsRequest = core.ExecuteCellsRequest
UpdateUIElementRequest = core.UpdateUIElementRequest
ModelRequest = core.ModelRequest
DeleteCellRequest = core.DeleteCellRequest
StdinRequest = core.StdinRequest
