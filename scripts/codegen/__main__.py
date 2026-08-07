# Copyright 2026 Marimo. All rights reserved.

"""Run every repository code generator through one command."""

from __future__ import annotations

import argparse
import pathlib
from collections.abc import Callable

from scripts.codegen import (
    effect_schemas,
    extension_commands,
    extension_constants,
    wasm_protocol,
)
from scripts.codegen.output import write_text, write_typescript

Generator = tuple[str, pathlib.Path, Callable[[], str]]

GENERATORS: tuple[Generator, ...] = (
    (
        extension_constants.LABEL,
        extension_constants.OUTPUT,
        extension_constants.generate,
    ),
    (
        extension_commands.LABEL,
        extension_commands.OUTPUT,
        extension_commands.generate,
    ),
    (effect_schemas.LABEL, effect_schemas.OUTPUT, effect_schemas.generate),
)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="fail if any checked-in generated file has drifted",
    )
    check = parser.parse_args().check

    drifted: list[pathlib.Path] = []
    for label, output, generate in GENERATORS:
        current = write_typescript(output, generate(), check=check)
        if current:
            print(f"✓ {label}: {output}")
        else:
            drifted.append(output)
            print(f"✗ {label}: {output} is out of date")

    current = write_text(
        wasm_protocol.OUTPUT,
        wasm_protocol.generate(),
        check=check,
    )
    if current:
        print(f"✓ {wasm_protocol.LABEL}: {wasm_protocol.OUTPUT}")
    else:
        drifted.append(wasm_protocol.OUTPUT)
        print(f"✗ {wasm_protocol.LABEL}: {wasm_protocol.OUTPUT} is out of date")

    if drifted:
        print("Run `just codegen` to regenerate checked-in sources.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
