# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING
from unittest.mock import ANY, Mock

import pytest

if TYPE_CHECKING:
    from types import ModuleType


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


def test_interrupt_delegates_to_marimo_kernel_manager(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    bridge = bridge_module._Bridge()
    bridge._manager = Mock()

    bridge.interrupt()

    bridge._manager.interrupt_kernel.assert_called_once_with()


def test_bridge_uses_normal_edit_mode_multiprocessing_manager(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    queues = Mock()
    manager = Mock()
    manager.kernel_connection.recv.side_effect = EOFError
    queue_manager = Mock(return_value=queues)
    kernel_manager = Mock(return_value=manager)
    write_frame = Mock()
    monkeypatch.setattr(bridge_module, "QueueManagerImpl", queue_manager)
    monkeypatch.setattr(bridge_module, "KernelManagerImpl", kernel_manager)
    monkeypatch.setattr(bridge_module, "_write_frame", write_frame)
    bridge = bridge_module._Bridge()
    args = SimpleNamespace(
        configs={},
        app_metadata=Mock(),
        user_config=Mock(),
        redirect_console_to_browser=True,
    )

    bridge.start(
        SimpleNamespace(
            working_directory=str(tmp_path),
            kernel_args=args,
        )
    )
    assert bridge._operation_thread is not None
    bridge._operation_thread.join(timeout=1)

    queue_manager.assert_called_once_with(use_multiprocessing=True)
    kernel_manager.assert_called_once_with(
        queue_manager=queues,
        mode=bridge_module.SessionMode.EDIT,
        configs={},
        app_metadata=args.app_metadata,
        config_manager=ANY,
        virtual_file_storage=None,
        redirect_console_to_browser=True,
    )
    config_manager = kernel_manager.call_args.kwargs["config_manager"]
    assert isinstance(config_manager, bridge_module._StaticConfigManager)
    assert config_manager.get_config() is args.user_config
    manager.start_kernel.assert_called_once_with()
    write_frame.assert_any_call(bridge_module.Ready())


def test_bridge_rejects_oversized_frame_before_reading_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    bridge_module = _load_bridge_module(monkeypatch)
    stream = Mock()
    stream.read.return_value = (bridge_module.MAX_FRAME_SIZE + 1).to_bytes(
        4, byteorder="big"
    )
    monkeypatch.setattr(bridge_module.sys, "stdin", SimpleNamespace(buffer=stream))

    with pytest.raises(ValueError, match="frame exceeds"):
        bridge_module._read_frame()

    stream.read.assert_called_once_with(bridge_module.HEADER_SIZE)
