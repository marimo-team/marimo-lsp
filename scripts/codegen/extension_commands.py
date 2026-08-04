# Copyright 2026 Marimo. All rights reserved.

"""Generate default typed extension command tokens from package.json."""

from __future__ import annotations

import json
import re

import msgspec

from scripts.codegen.output import EXTENSION

OUTPUT = EXTENSION / "src" / "commands" / "CommandIds.gen.ts"
LABEL = "extension commands"

SURFACE_NAMES = {
    "file/newFile": "fileNew",
    "notebook/toolbar": "notebookToolbar",
    "notebook/cell/title": "notebookCellTitle",
    "editor/title": "editorTitle",
    "view/title": "viewTitle",
    "view/item/context": "viewItemContext",
}
SUPPORTED_MENUS = {"commandPalette", *SURFACE_NAMES}


class Command(msgspec.Struct):
    command: str


class MenuItem(msgspec.Struct, omit_defaults=True):
    command: str
    when: str | None = None


class Contributes(msgspec.Struct):
    commands: list[Command]
    menus: dict[str, list[MenuItem]]


class PackageJson(msgspec.Struct):
    contributes: Contributes


def _name(command_id: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", command_id.removeprefix("marimo."))
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


def validate_menu_surfaces(menus: dict[str, list[MenuItem]]) -> None:
    unsupported = sorted(set(menus) - SUPPORTED_MENUS)
    if unsupported:
        message = f"Unsupported command menu surfaces: {unsupported}"
        raise ValueError(message)


def generate() -> str:
    package = msgspec.json.decode(
        (EXTENSION / "package.json").read_bytes(),
        type=PackageJson,
    )
    validate_menu_surfaces(package.contributes.menus)
    command_ids = "\n".join(
        f"  {_name(entry.command)}: {json.dumps(entry.command)},"
        for entry in sorted(package.contributes.commands, key=lambda item: item.command)
    )
    hidden_from_palette = {
        item.command
        for item in package.contributes.menus.get("commandPalette", [])
        if item.when == "never"
    }
    surfaces_by_command: dict[str, set[str]] = {
        entry.command: set() for entry in package.contributes.commands
    }
    for command_id, surfaces in surfaces_by_command.items():
        if command_id not in hidden_from_palette:
            surfaces.add("commandPalette")
    for menu, surface in SURFACE_NAMES.items():
        for item in package.contributes.menus.get(menu, []):
            if item.command in surfaces_by_command:
                surfaces_by_command[item.command].add(surface)
    command_surfaces = "\n".join(
        f"  {_name(entry.command)}: {json.dumps(sorted(surfaces_by_command[entry.command]))},"
        for entry in sorted(package.contributes.commands, key=lambda item: item.command)
    )
    return f"""// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `extension/package.json` by `scripts.codegen`.
// Regenerate with `just codegen`.
/* oxlint-disable marimo/no-marimo-command-id-literals -- generated source of truth */
export const CommandIds = {{
{command_ids}
}} as const;

export const CommandSurfaces = {{
{command_surfaces}
}} as const;
"""
