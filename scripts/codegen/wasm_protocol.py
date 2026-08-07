# Copyright 2026 Marimo. All rights reserved.

"""Vendor the typed WASM kernel protocol beside the standalone bridge."""

from __future__ import annotations

from scripts.codegen.output import EXTENSION, ROOT

LABEL = "WASM kernel protocol"
SOURCE = ROOT / "src" / "marimo_lsp" / "wasm" / "protocol.py"
OUTPUT = EXTENSION / "resources" / "wasm" / "protocol.py"


def generate() -> str:
    """Return the standalone copy with a generated-file warning."""
    source = SOURCE.read_text(encoding="utf-8")
    copyright_line, remainder = source.split("\n", 1)
    return (
        f"{copyright_line}\n\n"
        "# Generated from `src/marimo_lsp/wasm/protocol.py` by `scripts.codegen`.\n"
        "# Regenerate with `just codegen`.\n"
        f"{remainder.lstrip()}"
    )
