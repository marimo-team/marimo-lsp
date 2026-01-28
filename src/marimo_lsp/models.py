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


class DebugAdapterRequest(msgspec.Struct, rename="camel"):
    """A forwarded DAP request."""

    session_id: str
    """A UUID for the debug session."""

    message: dict
    """The DAP message."""


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


class ExecuteScratchRequest(msgspec.Struct, rename="camel"):
    """Execute arbitrary Python code outside the dependency graph."""

    code: str
    """The Python code to execute."""


class UpdateConfigurationRequest(msgspec.Struct, rename="camel"):
    """A request to update the user configuration."""

    config: dict[str, typing.Any]
    """The partial configuration to merge with the current config."""


class ApiRequest(msgspec.Struct, rename="camel"):
    """A unified API request for all marimo internal methods."""

    method: str
    """The API method to call (e.g., 'run', 'interrupt', 'serialize')."""

    params: dict[str, typing.Any]
    """The parameters for the method."""


ExecuteCellsRequest = core.ExecuteCellsRequest
UpdateUIElementRequest = core.UpdateUIElementRequest
DeleteCellRequest = core.DeleteCellRequest
