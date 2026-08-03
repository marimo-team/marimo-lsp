# Copyright 2026 Marimo. All rights reserved.

"""Generate extension constants from package.json and pyproject.toml."""

from __future__ import annotations

import json
import tomllib

import msgspec

from scripts.codegen.output import EXTENSION, ROOT

OUTPUT = EXTENSION / "src" / "constants.ts"
LABEL = "extension constants"


class View(msgspec.Struct):
    id: str


class Notebook(msgspec.Struct):
    type: str


class Contributes(msgspec.Struct):
    views: dict[str, list[View]]
    notebooks: tuple[Notebook]


class PackageJson(msgspec.Struct):
    contributes: Contributes


def _quoted(value: str) -> str:
    return json.dumps(value)


def _union(values: list[str]) -> str:
    return " | ".join(_quoted(value) for value in sorted(values))


def generate() -> str:
    package = msgspec.json.decode(
        (EXTENSION / "package.json").read_bytes(),
        type=PackageJson,
    )
    contributes = package.contributes
    if len(contributes.views) != 1:
        msg = f"expected one view contribution, found {list(contributes.views)}"
        raise ValueError(msg)

    view_ids = [entry.id for entries in contributes.views.values() for entry in entries]
    notebook_type = contributes.notebooks[0].type
    pyproject = tomllib.loads((ROOT / "pyproject.toml").read_text())
    version = pyproject["tool"]["marimo-lsp"]["minimum-kernel-version"]
    major, minor, patch = (int(part) for part in version.split("."))
    context_keys = [
        "marimo.notebook.hasStaleCells",
        "marimo.notebook.hasKernel",
        "marimo.config.runtime.on_cell_change",
        "marimo.config.runtime.auto_reload",
        "marimo.hasLiveSessions",
        "marimo.isPythonFileMarimoNotebook",
    ]
    return f"""// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `extension/package.json` and `pyproject.toml` by `scripts.codegen`.
// Regenerate with `just codegen`.
import type {{ CellId }} from "./types.ts";

export type MarimoView = {_union(view_ids)};

export const NOTEBOOK_TYPE = {_quoted(notebook_type)};

export const SETUP_CELL_NAME = "setup";

// oxlint-disable-next-line typescript/no-unsafe-type-assertion
export const SCRATCH_CELL_ID = "__scratch__" as CellId;

export const LanguageId = {{
  /**
   * Language ID for Python cells in marimo notebooks.
   *
   * Using a custom language ID ("mo-python") prevents other
   * Python language servers from providing duplicate completions
   * and diagnostics.
   */
  Python: "mo-python",
  /** Language ID for SQL cells in marimo notebooks. */
  Sql: "sql",
  /** Language ID for Markdown cells in marimo notebooks. */
  Markdown: "markdown",
}} as const;

export const MINIMUM_MARIMO_KERNEL_VERSION = {{
  major: {major},
  minor: {minor},
  patch: {patch},
}} as const;

export type MarimoContextKey = {_union(context_keys)};
"""
