"""Marimo models rewritten in attrs for `pygls` compatibility."""

from __future__ import annotations

import re
from typing import TYPE_CHECKING, Any

import attrs
import marimo._server.models.models as core
from marimo._runtime import requests
from pygls.protocol import default_converter

if TYPE_CHECKING:
    import cattrs


@attrs.define
class BaseRequest:
    """Base class for marimo's custom LSP commands."""


@attrs.define
class RunRequest(BaseRequest):
    """
    A request to execute specific cells in a marimo notebook.

    Wraps `marimo._server.models.RunRequest` with notebook context.
    """

    notebook_uri: str
    """The URI of the notebook."""

    cell_ids: list[core.CellId_t]
    """The IDs of the cells to run."""

    codes: list[str]
    """Code to register or run for each cell."""

    def into_marimo(self) -> core.RunRequest:
        """Convert to the marimo core RunRequest."""
        return core.RunRequest(
            cell_ids=self.cell_ids,
            codes=self.codes,
        )


@attrs.define
class SetUIElementValueRequest(BaseRequest):
    """
    A request to update ui elements in a marimo notebook.

    Wraps `marimo._runtime.requests.SetUIElementValueRequest` with notebook context.
    """

    notebook_uri: str
    """The URI of the notebook."""

    object_ids: list[core.UIElementId]
    """Identifiers for the UI elements"""

    values: list[Any]
    """Corresponding values for the UI elements"""

    token: str
    """Dummy token that is technically required"""

    def into_marimo(self) -> requests.SetUIElementValueRequest:
        """Convert to the marimo SetUIElementValueRequest."""
        return requests.SetUIElementValueRequest(
            object_ids=self.object_ids, values=self.values
        )


@attrs.define
class SerializeRequest(BaseRequest):
    """
    A request to serialize a notebook to Python source.

    Contains the notebook data to be serialized.
    """

    notebook: dict[str, Any]
    """The notebook data in marimo's internal format."""


@attrs.define
class DeserializeRequest(BaseRequest):
    """
    A request to deserialize Python source to notebook format.

    Contains the source code to be parsed.
    """

    source: str
    """The Python source code to deserialize."""


def _camel_to_snake(name: str) -> str:
    s1 = re.sub(r"(.)([A-Z][a-z]+)", r"\1_\2", name)
    return re.sub(r"([A-Z]+)([A-Z][a-z]*)", r"\1_\2", s1).lower()


def _structure_base_request(data: object, cls: type[BaseRequest]) -> BaseRequest:
    """Structure hook that converts camelCase keys to snake_case."""
    if isinstance(data, dict):
        converted = {}
        for key, value in data.items():
            snake_key = _camel_to_snake(key)
            converted[snake_key] = value
        return cls(**converted)
    return data  # type: ignore[return-value]


def converter_factory() -> cattrs.Converter:
    """Extend `pygls` attrs converter with `BaseRequest` camelCase support."""
    converter = default_converter()
    converter.register_structure_hook(BaseRequest, _structure_base_request)
    return converter
