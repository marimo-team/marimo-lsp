# Copyright 2026 Marimo. All rights reserved.

import pytest

from scripts.codegen.extension_commands import MenuItem, validate_menu_surfaces


def test_rejects_unsupported_command_menu_surfaces() -> None:
    menus = {"editor/context": [MenuItem(command="marimo.example")]}

    with pytest.raises(
        ValueError,
        match=r"Unsupported command menu surfaces: \['editor/context'\]",
    ):
        validate_menu_surfaces(menus)


def test_accepts_supported_command_menu_surfaces() -> None:
    menus = {
        "commandPalette": [MenuItem(command="marimo.example")],
        "notebook/toolbar": [MenuItem(command="marimo.example")],
    }

    validate_menu_surfaces(menus)
