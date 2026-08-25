# Copyright 2026 Marimo. All rights reserved.

"""Launch and communicate with marimo kernels."""

from __future__ import annotations

import typing

if typing.TYPE_CHECKING:
    from collections.abc import Callable

    from marimo._config.manager import MarimoConfigManager
    from marimo._messaging.types import KernelMessage
    from marimo._runtime.commands import CommandMessage

    from marimo_lsp.app_file_manager import LspAppFileManager


class Kernel(typing.Protocol):
    """A live marimo kernel."""

    executable: str
    working_directory: str
    marimo_version: str | None
    session_cache_path: str | None

    def send(self, request: CommandMessage) -> None:
        """Send a command to the kernel."""
        ...

    def input(self, text: str) -> None:
        """Send a response to a kernel input request."""
        ...

    def interrupt(self) -> None:
        """Interrupt the kernel."""
        ...

    def close(self) -> None:
        """Close the kernel and its transport."""
        ...


class Kernels(typing.Protocol):
    """Obtain ready marimo kernels."""

    async def launch(
        self,
        *,
        executable: str,
        working_directory: str,
        app_file_manager: LspAppFileManager,
        config_manager: MarimoConfigManager,
        receive: Callable[[KernelMessage], None],
    ) -> Kernel:
        """Launch a kernel and begin delivering its operations."""
        ...


class KernelOpenError(RuntimeError):
    """A kernel failed before it became ready."""
