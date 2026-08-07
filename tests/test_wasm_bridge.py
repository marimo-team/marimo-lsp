# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path
from typing import TYPE_CHECKING
from unittest.mock import Mock

if TYPE_CHECKING:
    from types import ModuleType

    import pytest


def _load_bridge_module(monkeypatch: pytest.MonkeyPatch) -> ModuleType:
    resource_directory = Path(__file__).parents[1] / "extension" / "resources" / "wasm"
    monkeypatch.syspath_prepend(str(resource_directory))
    spec = importlib.util.spec_from_file_location(
        "marimo_lsp_test_wasm_bridge",
        resource_directory / "kernel.py",
    )
    assert spec is not None
    assert spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_windows_interrupt_uses_positional_queue_value(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    bridge = bridge_module._Bridge()
    bridge._process = Mock(pid=42)
    bridge._process.poll.return_value = None
    bridge._queues = Mock()
    interrupt_queue = bridge._queues.win32_interrupt_queue
    monkeypatch.setattr(sys, "platform", "win32")

    bridge.interrupt()

    interrupt_queue.put_nowait.assert_called_once_with(True)  # noqa: FBT003
