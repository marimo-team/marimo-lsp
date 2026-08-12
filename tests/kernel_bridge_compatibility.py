# Copyright 2026 Marimo. All rights reserved.

"""Smoke-test the selected-Python kernel bridge in an isolated environment."""

from __future__ import annotations

import importlib.util
import sys
from importlib.metadata import version
from pathlib import Path

RESOURCE_DIRECTORY = Path(__file__).parents[1] / "extension" / "resources" / "wasm"
KERNEL_SCRIPT = RESOURCE_DIRECTORY / "kernel.py"


def main() -> None:
    """Import the packaged bridge and all of its selected-Python dependencies."""
    sys.path.insert(0, str(RESOURCE_DIRECTORY))
    try:
        spec = importlib.util.spec_from_file_location(
            "marimo_kernel_bridge_compatibility",
            KERNEL_SCRIPT,
        )
        if spec is None or spec.loader is None:
            msg = f"Could not load {KERNEL_SCRIPT}"
            raise RuntimeError(msg)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    finally:
        sys.path.remove(str(RESOURCE_DIRECTORY))

    sys.stdout.write(
        f"Imported kernel bridge with Python {sys.version.split()[0]} "
        f"and marimo {version('marimo')}\n"
    )


if __name__ == "__main__":
    main()
