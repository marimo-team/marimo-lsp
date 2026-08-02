"""Generate default typed extension command tokens from package.json."""

from __future__ import annotations

import json
import re

import msgspec

from scripts.codegen.output import EXTENSION

OUTPUT = EXTENSION / "src" / "commands" / "MarimoCommands.gen.ts"
LABEL = "extension commands"


class Command(msgspec.Struct):
    command: str


class Contributes(msgspec.Struct):
    commands: list[Command]


class PackageJson(msgspec.Struct):
    contributes: Contributes


def _name(command_id: str) -> str:
    parts = re.split(r"[^A-Za-z0-9]+", command_id.removeprefix("marimo."))
    return parts[0] + "".join(part[:1].upper() + part[1:] for part in parts[1:])


def generate() -> str:
    package = msgspec.json.decode(
        (EXTENSION / "package.json").read_bytes(),
        type=PackageJson,
    )
    entries = "\n".join(
        f"  {_name(entry.command)}: marimoCommand({json.dumps(entry.command)}),"
        for entry in sorted(package.contributes.commands, key=lambda item: item.command)
    )
    return f"""// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `extension/package.json` by `scripts.codegen`.
// Regenerate with `just codegen`.
import {{ marimoCommand }} from "../commands.ts";

export const GeneratedMarimoCommands = {{
{entries}
}} as const;
"""
