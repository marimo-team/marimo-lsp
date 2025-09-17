"""Marimo models rewritten in attrs for `pygls` compatibility."""

from __future__ import annotations

import typing

import marimo._server.models.models as core
import msgspec
from marimo._runtime import requests

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
    """They DAP message."""


RunRequest = core.RunRequest
SetUIElementValueRequest = requests.SetUIElementValueRequest
