# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast
from unittest.mock import Mock

import msgspec
import pytest
from inline_snapshot import snapshot
from marimo._config.config import DEFAULT_CONFIG
from marimo._messaging.types import KernelMessage
from marimo._runtime.commands import ExecuteCellsCommand

from marimo_lsp.kernels import KernelOpenError
from marimo_lsp.wasm.kernels import WasmKernels
from marimo_lsp.wasm.protocol import (
    MAX_FRAME_SIZE,
    Decoder,
    Error,
    FromBridge,
    Operation,
    Ready,
    ToBridge,
    encode,
)

if TYPE_CHECKING:
    from marimo._config.manager import MarimoConfigManager

    from marimo_lsp.app_file_manager import LspAppFileManager


class _Callbacks:
    def __init__(self) -> None:
        self.spawns: list[tuple[str, str, str]] = []
        self.writes: list[tuple[str, bytes]] = []
        self.closes: list[str] = []

    def spawn(
        self,
        process_id: str,
        executable: str,
        working_directory: str,
    ) -> None:
        self.spawns.append((process_id, executable, working_directory))

    def write(self, process_id: str, chunk: bytes) -> None:
        self.writes.append((process_id, chunk))

    def close(self, process_id: str) -> None:
        self.closes.append(process_id)


async def _begin_launch():
    callbacks = _Callbacks()
    kernels = WasmKernels(callbacks)
    app_file_manager = SimpleNamespace(
        path="/workspace/notebook.py",
        app=SimpleNamespace(
            config={},
            cell_manager=SimpleNamespace(config_map=dict),
        ),
    )
    config_manager = Mock()
    config_manager.get_config.return_value = DEFAULT_CONFIG
    messages: list[KernelMessage] = []
    launch = asyncio.create_task(
        kernels.launch(
            executable="/python",
            working_directory="/workspace",
            app_file_manager=cast("LspAppFileManager", app_file_manager),
            config_manager=cast("MarimoConfigManager", config_manager),
            receive=messages.append,
        )
    )
    await asyncio.sleep(0)
    return callbacks, kernels, launch, messages


async def _launch_kernel():
    callbacks, kernels, launch, messages = await _begin_launch()
    process_id = callbacks.spawns[0][0]
    kernels.accept(process_id, encode(Ready()))
    kernel = await launch
    return callbacks, kernels, kernel, messages


@pytest.mark.asyncio
async def test_wasm_launch_fails_before_publishing_unready_kernel() -> None:
    callbacks, kernels, launch, _messages = await _begin_launch()
    process_id = callbacks.spawns[0][0]

    kernels.accept(process_id, encode(Error(message="failed to start")))

    with pytest.raises(KernelOpenError, match="failed to start"):
        await launch
    assert callbacks.closes == snapshot([process_id])


@pytest.mark.asyncio
async def test_wasm_process_exit_includes_stderr_in_open_error() -> None:
    callbacks, kernels, launch, _messages = await _begin_launch()
    process_id = callbacks.spawns[0][0]

    kernels.exited(process_id, 1, None, "ModuleNotFoundError: No module named 'marimo'")

    with pytest.raises(KernelOpenError) as exc_info:
        await launch
    assert "Kernel bridge exited unexpectedly (code=1, signal=None)" in str(
        exc_info.value
    )
    assert "Bridge stderr:" in str(exc_info.value)
    assert "ModuleNotFoundError" in str(exc_info.value)


@pytest.mark.asyncio
async def test_cancelled_wasm_launch_releases_bridge() -> None:
    callbacks, _kernels, launch, _messages = await _begin_launch()
    process_id = callbacks.spawns[0][0]

    launch.cancel()

    with pytest.raises(asyncio.CancelledError):
        await launch
    assert callbacks.closes == snapshot([process_id])


@pytest.mark.asyncio
async def test_wasm_kernel_forwards_lifecycle_and_messages() -> None:
    callbacks, kernels, kernel, messages = await _launch_kernel()
    process_id = callbacks.spawns[0][0]

    kernel.send(ExecuteCellsCommand(cell_ids=[], codes=[]))
    kernel.input("answer")
    kernel.interrupt()
    operation = encode(Operation(message=msgspec.Raw(b'{"op":"ready"}')))
    kernels.accept(process_id, operation[:3])
    kernels.accept(process_id, operation[3:])
    kernel.close()

    decoder = Decoder(ToBridge)
    wire_messages = [
        message for _, chunk in callbacks.writes for message in decoder.feed(chunk)
    ]
    wire = [
        msgspec.json.decode(msgspec.json.encode(message)) for message in wire_messages
    ]
    kernel_args = wire[0]["kernelArgs"]
    assert {
        "spawn": callbacks.spawns,
        "start": {
            "type": wire[0]["type"],
            "workingDirectory": wire[0]["workingDirectory"],
            "filename": kernel_args["app_metadata"]["filename"],
            "theme": kernel_args["user_config"]["display"]["theme"],
        },
        "request": {
            "type": wire[1]["type"],
            "requestType": wire[1]["request"]["type"],
        },
        "input": wire[2],
        "interrupt": wire[3],
        "close": wire[4],
        "closes": callbacks.closes,
        "operations": messages,
    } == snapshot(
        {
            "spawn": [(process_id, "/python", "/workspace")],
            "start": {
                "type": "start",
                "workingDirectory": "/workspace",
                "filename": "/workspace/notebook.py",
                "theme": "light",
            },
            "request": {"type": "control", "requestType": "execute-cells"},
            "input": {"type": "input", "text": "answer", "version": 1},
            "interrupt": {"type": "interrupt", "version": 1},
            "close": {"type": "close", "version": 1},
            "closes": [process_id],
            "operations": [KernelMessage(b'{"op":"ready"}')],
        }
    )


@pytest.mark.asyncio
async def test_closed_wasm_kernel_drops_late_messages() -> None:
    callbacks, kernels, kernel, messages = await _launch_kernel()
    process_id = callbacks.spawns[0][0]

    kernel.close()
    kernels.accept(
        process_id,
        encode(Operation(message=msgspec.Raw(b'{"op":"late"}'))),
    )

    assert messages == snapshot([])


@pytest.mark.asyncio
async def test_ready_wasm_kernel_failure_releases_bridge() -> None:
    callbacks, kernels, _kernel, messages = await _launch_kernel()
    process_id = callbacks.spawns[0][0]

    kernels.accept(process_id, encode(Error(message="bridge failed")))
    kernels.accept(
        process_id,
        encode(Operation(message=msgspec.Raw(b'{"op":"late"}'))),
    )

    assert callbacks.closes == snapshot([process_id])
    assert messages == snapshot(
        [KernelMessage(b'{"op": "kernel-startup-error", "error": "bridge failed"}')]
    )


@pytest.mark.asyncio
async def test_failed_close_write_still_releases_bridge() -> None:
    callbacks, kernels, kernel, messages = await _launch_kernel()
    process_id = callbacks.spawns[0][0]
    callbacks.write = Mock(side_effect=RuntimeError("write failed"))

    with pytest.raises(RuntimeError, match="write failed"):
        kernel.close()
    kernels.accept(
        process_id,
        encode(Operation(message=msgspec.Raw(b'{"op":"late"}'))),
    )

    assert callbacks.closes == snapshot([process_id])
    assert messages == snapshot([])


def test_decoder_rejects_and_discards_oversized_frame() -> None:
    decoder = Decoder(FromBridge)
    oversized_header = (MAX_FRAME_SIZE + 1).to_bytes(4, byteorder="big")

    with pytest.raises(ValueError, match="frame exceeds"):
        decoder.feed(oversized_header)

    assert decoder.feed(encode(Ready())) == [Ready()]
