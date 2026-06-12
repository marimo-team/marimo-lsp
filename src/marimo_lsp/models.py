"""Marimo models rewritten in attrs for `pygls` compatibility."""

from __future__ import annotations

import typing

import marimo._server.models.models as core
import msgspec

T = typing.TypeVar("T", bound=msgspec.Struct)


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
    rather than the scratch cell's idle. See ADR 0001 / the streaming model.
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
