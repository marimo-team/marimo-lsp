# Copyright 2026 Marimo. All rights reserved.

# Generated from `src/marimo_lsp/wasm/protocol.py` by `scripts.codegen`.
# Regenerate with `just codegen`.
"""Typed messages exchanged with the selected-Python kernel bridge."""

from __future__ import annotations

import struct
from typing import TYPE_CHECKING, Generic, Literal, TypeAlias, TypeVar

import marimo._ipc as ipc
import msgspec

# msgspec resolves these postponed annotations when it constructs decoders.
from marimo._ipc.types import ConnectionInfo  # noqa: TC002
from marimo._runtime.commands import CommandMessage  # noqa: TC002

if TYPE_CHECKING:
    from typing_extensions import TypeForm

VERSION = 1
_HEADER = struct.Struct(">I")
HEADER_SIZE = _HEADER.size
MAX_FRAME_SIZE = 64 * 1024 * 1024


class Ready(msgspec.Struct, tag="ready", tag_field="type", rename="camel"):
    """The kernel bridge is ready."""

    marimo_version: str | None = None
    version: Literal[1] = VERSION


class Operation(msgspec.Struct, tag="operation", tag_field="type", rename="camel"):
    """An opaque marimo kernel operation."""

    message: msgspec.Raw
    version: Literal[1] = VERSION


class Error(msgspec.Struct, tag="error", tag_field="type", rename="camel"):
    """The kernel bridge failed."""

    message: str
    version: Literal[1] = VERSION


class Log(msgspec.Struct, tag="log", tag_field="type", rename="camel"):
    """A kernel log line."""

    message: str
    version: Literal[1] = VERSION


FromBridge: TypeAlias = Ready | Operation | Error | Log


class KernelLaunchArgs(ipc.KernelArgs):
    """Kernel arguments before the selected Python binds its IPC sockets.

    TODO: Replace this compatibility shim when marimo._ipc separates portable
    kernel arguments from the connection information required to launch them.
    """

    connection_info: ConnectionInfo | None = None


class Start(msgspec.Struct, tag="start", tag_field="type", rename="camel"):
    """Start a kernel."""

    working_directory: str
    kernel_args: KernelLaunchArgs
    version: Literal[1] = VERSION


class Control(msgspec.Struct, tag="control", tag_field="type", rename="camel"):
    """Send a marimo command."""

    request: CommandMessage
    version: Literal[1] = VERSION


class Input(msgspec.Struct, tag="input", tag_field="type", rename="camel"):
    """Respond to a kernel input request."""

    text: str
    version: Literal[1] = VERSION


class Interrupt(msgspec.Struct, tag="interrupt", tag_field="type", rename="camel"):
    """Interrupt the kernel."""

    version: Literal[1] = VERSION


class Close(msgspec.Struct, tag="close", tag_field="type", rename="camel"):
    """Close the kernel."""

    version: Literal[1] = VERSION


ToBridge: TypeAlias = Start | Control | Input | Interrupt | Close

Message = TypeVar("Message")


def encode(message: FromBridge | ToBridge) -> bytes:
    """Encode one length-prefixed protocol message."""
    payload = msgspec.json.encode(message)
    if len(payload) > MAX_FRAME_SIZE:
        msg = f"Kernel frame exceeds {MAX_FRAME_SIZE} bytes"
        raise ValueError(msg)
    return _HEADER.pack(len(payload)) + payload


def read_header(header: bytes | bytearray) -> int:
    """Decode a complete frame header into its payload length."""
    if len(header) != _HEADER.size:
        message = "Incomplete kernel frame header"
        raise EOFError(message)
    return _HEADER.unpack(header)[0]


class Decoder(Generic[Message]):
    """Decode length-prefixed messages across arbitrary byte chunks."""

    def __init__(self, message_type: TypeForm[Message]) -> None:
        self._buffer = bytearray()
        self._decoder = msgspec.json.Decoder(message_type)

    def feed(self, chunk: bytes) -> list[Message]:
        """Decode every complete message in a chunk."""
        self._buffer.extend(chunk)
        messages: list[Message] = []
        while len(self._buffer) >= _HEADER.size:
            length = read_header(self._buffer[: _HEADER.size])
            if length > MAX_FRAME_SIZE:
                self._buffer.clear()
                msg = f"Kernel frame exceeds {MAX_FRAME_SIZE} bytes"
                raise ValueError(msg)
            frame_length = _HEADER.size + length
            if len(self._buffer) < frame_length:
                break
            payload = bytes(self._buffer[_HEADER.size : frame_length])
            del self._buffer[:frame_length]
            messages.append(self._decoder.decode(payload))
        return messages
