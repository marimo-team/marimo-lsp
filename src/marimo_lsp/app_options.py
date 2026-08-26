# Copyright 2026 Marimo. All rights reserved.

"""Adapt owned app options at the marimo runtime boundary."""

from __future__ import annotations

import ast
import dataclasses
import math
from typing import TYPE_CHECKING

from marimo._ast.app_config import _AppConfig
from marimo._ast.parse import Parser

from marimo_lsp import protocol

if TYPE_CHECKING:
    from collections.abc import Mapping

# Do not use _AppConfig.from_untrusted_dict to discover these: it treats
# method names such as `asdict` as writable config attributes.
MARIMO_APP_CONFIG_FIELDS = frozenset(
    field.name for field in dataclasses.fields(_AppConfig)
)


def split_app_options(options: Mapping[str, object]) -> protocol.AppOptions:
    """Split marimo's flat kwargs into managed and passthrough options."""
    passthrough = dict(options)
    raw_auto_download = passthrough.pop("auto_download", [])
    if not isinstance(raw_auto_download, list):
        msg = "marimo.App auto_download must be a list of strings"
        raise TypeError(msg)
    auto_download: list[str] = []
    for item in raw_auto_download:
        if not isinstance(item, str):
            msg = "marimo.App auto_download must be a list of strings"
            raise TypeError(msg)
        auto_download.append(item)
    return protocol.AppOptions(
        managed=protocol.ManagedAppOptions(auto_download=auto_download),
        passthrough=passthrough,
    )


def merge_app_options(options: protocol.AppOptions) -> dict[str, object]:
    """Rebuild flat marimo kwargs, with managed values winning collisions."""
    return {
        **options.passthrough,
        "auto_download": options.managed.auto_download,
    }


def app_options_from_source(
    source: str,
    parsed_options: Mapping[str, object],
) -> protocol.AppOptions:
    """Recover literal app kwargs before marimo normalizes their values.

    Marimo's parser intentionally understands only constants and flat lists of
    constants. The private protocol can preserve any JSON-shaped literal, so
    overlay those source values on the options marimo successfully parsed.
    """
    options = {
        name: value for name, value in parsed_options.items() if _is_json_value(value)
    }
    options.update(_literal_app_options(source))
    return split_app_options(options)


def _literal_app_options(source: str) -> dict[str, object]:
    body = Parser(source, filepath="notebook.py").node_stack()
    call: ast.Call | None = None
    while (node := next(body)) is not None:
        if (
            isinstance(node, ast.Assign)
            and len(node.targets) == 1
            and isinstance(node.targets[0], ast.Name)
            and node.targets[0].id == "app"
            and isinstance(node.value, ast.Call)
            and isinstance(node.value.func, ast.Attribute)
            and isinstance(node.value.func.value, ast.Name)
            and node.value.func.attr == "App"
        ):
            call = node.value
            break
    if call is None:
        return {}

    options: dict[str, object] = {}
    for keyword in call.keywords:
        if keyword.arg is None:
            continue
        try:
            value = ast.literal_eval(keyword.value)
        except (ValueError, SyntaxError):
            continue
        if _is_json_value(value):
            options[keyword.arg] = value
    return options


def _is_json_value(value: object) -> bool:
    if value is None or isinstance(value, bool | int | str):
        return True
    if isinstance(value, float):
        return math.isfinite(value)
    if isinstance(value, list):
        return all(_is_json_value(item) for item in value)
    if isinstance(value, dict):
        return all(
            isinstance(key, str) and _is_json_value(item) for key, item in value.items()
        )
    return False
