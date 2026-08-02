# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import Mock

import pytest

from marimo_lsp.kernel_manager import LspKernelManager

if TYPE_CHECKING:
    from pathlib import Path


def _manager(notebook: Path, working_directory: str | None) -> LspKernelManager:
    manager = LspKernelManager.__new__(LspKernelManager)
    manager.executable = "/usr/bin/python"
    manager.connection_info = Mock()
    manager.configs = {}
    manager.app_metadata = SimpleNamespace(filename=str(notebook))
    manager.config_manager = Mock()
    manager.config_manager.get_config.return_value = {}
    manager.working_directory = working_directory
    return manager


def test_supplied_working_directory_reaches_launch_kernel(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launch = Mock(return_value=Mock())
    monkeypatch.setattr("marimo_lsp.kernel_manager.launch_kernel", launch)
    selected = tmp_path / "selected"
    selected.mkdir()

    manager = _manager(tmp_path / "notebook.py", str(selected))
    manager.start_kernel()

    assert launch.call_args.kwargs["cwd"] == str(selected)


def test_omitted_working_directory_uses_notebook_directory(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launch = Mock(return_value=Mock())
    monkeypatch.setattr("marimo_lsp.kernel_manager.launch_kernel", launch)

    manager = _manager(tmp_path / "notebook.py", None)
    manager.start_kernel()

    assert launch.call_args.kwargs["cwd"] == str(tmp_path)


@pytest.mark.parametrize("kind", ["relative", "missing", "file"])
def test_invalid_working_directory_is_rejected(
    kind: str, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    launch = Mock(return_value=Mock())
    monkeypatch.setattr("marimo_lsp.kernel_manager.launch_kernel", launch)
    if kind == "relative":
        selected = "relative/path"
    elif kind == "missing":
        selected = str(tmp_path / "missing")
    else:
        file = tmp_path / "file"
        file.write_text("")
        selected = str(file)

    manager = _manager(tmp_path / "notebook.py", selected)
    with pytest.raises(ValueError, match="working directory"):
        manager.start_kernel()

    launch.assert_not_called()
