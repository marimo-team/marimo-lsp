# Copyright 2026 Marimo. All rights reserved.

"""Shared output handling for TypeScript generators."""

from __future__ import annotations

import pathlib
import subprocess

ROOT = pathlib.Path(__file__).parents[2]
EXTENSION = ROOT / "extension"


def write_text(
    output: pathlib.Path,
    source: str,
    *,
    check: bool,
) -> bool:
    """Write generated text or report whether the checked-in copy is current."""
    if output.exists() and output.read_text(encoding="utf-8") == source:
        return True
    if check:
        return False
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(source, encoding="utf-8")
    return True


def write_typescript(
    output: pathlib.Path,
    source: str,
    *,
    check: bool,
) -> bool:
    """Format generated TypeScript, then write it or report whether it is current."""
    formatter_output = subprocess.run(  # noqa: S603
        [  # noqa: S607
            "pnpm",
            "--silent",
            "exec",
            "vp",
            "fmt",
            "--stdin-filepath",
            str(output.relative_to(EXTENSION)),
        ],
        cwd=EXTENSION,
        check=True,
        input=source,
        capture_output=True,
        encoding="utf-8",
    ).stdout
    first_line = source.splitlines()[0]
    if not formatter_output.startswith(first_line):
        msg = f"formatter wrote diagnostics to stdout:\n{formatter_output}"
        raise RuntimeError(msg)
    formatted = formatter_output

    if output.exists() and output.read_text(encoding="utf-8") == formatted:
        return True
    if check:
        return False
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(formatted, encoding="utf-8")
    return True
