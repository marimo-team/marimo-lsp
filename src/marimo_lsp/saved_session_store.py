# Copyright 2026 Marimo. All rights reserved.

"""Host filesystem boundary for saved sessions."""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

if TYPE_CHECKING:
    from collections.abc import Awaitable


class SavedSessionFiles(Protocol):
    """Write a saved session on the language server's host."""

    async def read(self, target: str) -> str | None:
        """Read a saved session when it exists."""
        ...

    async def write(self, target: str, contents: str) -> None:
        """Write one complete saved session."""
        ...


class LocalSavedSessionFiles:
    """Write through the native language server filesystem."""

    async def read(self, target: str) -> str | None:
        """Read a saved session when it exists."""
        destination = Path(target)
        if not destination.is_absolute():
            msg = f"Saved session path must be absolute: {target}"
            raise ValueError(msg)
        try:
            return await asyncio.to_thread(destination.read_text, encoding="utf-8")
        except FileNotFoundError:
            return None

    async def write(self, target: str, contents: str) -> None:
        """Write one complete saved session."""
        destination = Path(target)
        if not destination.is_absolute():
            msg = f"Saved session path must be absolute: {target}"
            raise ValueError(msg)

        def write() -> None:
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(contents, encoding="utf-8")

        await asyncio.to_thread(write)


class SavedSessionFileCallbacks(Protocol):
    """Host callbacks supplied to the Pyodide language server."""

    def read(self, target: str) -> Awaitable[str | None]:
        """Read a saved session from the host when it exists."""
        ...

    def write(self, target: str, contents: str) -> Awaitable[None]:
        """Write one complete saved session on the host."""
        ...


class CallbackSavedSessionFiles:
    """Write through the extension host callback."""

    def __init__(self, callbacks: SavedSessionFileCallbacks) -> None:
        self._callbacks = callbacks

    async def read(self, target: str) -> str | None:
        """Read a saved session through the host."""
        return await self._callbacks.read(target)

    async def write(self, target: str, contents: str) -> None:
        """Write one complete saved session through the host."""
        await self._callbacks.write(target, contents)
