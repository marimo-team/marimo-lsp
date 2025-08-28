"""Types for marimo-lsp."""

from __future__ import annotations

from typing import TYPE_CHECKING

import msgspec
from marimo._messaging.msgspec_encoder import encode_json_str

if TYPE_CHECKING:
    from marimo._config.config import MarimoConfig
    from marimo._runtime.requests import AppMetadata


def encode_kernel_args(args: KernelArgs) -> str:
    """Encode kernel args as JSON."""
    return encode_json_str(args)


def decode_kernel_args(json: str) -> KernelArgs:
    """Encode kernel args as JSON."""
    return msgspec.json.decode(json, type=KernelArgs)


class KernelArgs(msgspec.Struct):
    """Args to send to the kernel."""

    configs: dict
    app_metadata: AppMetadata
    user_config: MarimoConfig
    log_level: int
