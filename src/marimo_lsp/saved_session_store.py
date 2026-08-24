# Copyright 2026 Marimo. All rights reserved.

"""Atomically replace saved-session sidecars on the LSP host."""

from __future__ import annotations

import asyncio
import os
import stat
import threading
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING, Protocol
from uuid import uuid4

if TYPE_CHECKING:
    from collections.abc import Awaitable


class SavedSessionFiles(Protocol):
    """The narrow host-filesystem boundary needed by saved sessions."""

    async def read(self, target: str) -> str | None:
        """Read target when it exists."""
        ...

    async def replace(self, target: str, contents: str) -> None:
        """Atomically replace target with contents."""
        ...


def _local_target(target: str) -> Path:
    destination = Path(target)
    if not destination.is_absolute():
        msg = f"Saved session path must be absolute: {target}"
        raise ValueError(msg)
    return destination


def _create_local(destination: Path) -> tuple[str, int]:
    destination.parent.mkdir(parents=True, exist_ok=True)
    try:
        destination_mode = stat.S_IMODE(destination.stat().st_mode)
    except FileNotFoundError:
        destination_mode = None

    while True:
        temporary = destination.parent / (f".{destination.name}.{uuid4().hex}.tmp")
        try:
            descriptor = os.open(
                temporary,
                os.O_WRONLY | os.O_CREAT | os.O_EXCL,
                0o666,
            )
        except FileExistsError:
            continue
        try:
            if destination_mode is not None and os.name != "nt":
                os.fchmod(descriptor, destination_mode)
        except BaseException:
            os.close(descriptor)
            temporary.unlink(missing_ok=True)
            raise
        return str(temporary), descriptor


def _write_local(
    temporary: str,
    descriptor: int,
    contents: str,
    abandoned: threading.Event,
) -> None:
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as output:
            output.write(contents)
    except BaseException:
        Path(temporary).unlink(missing_ok=True)
        raise
    finally:
        if abandoned.is_set():
            Path(temporary).unlink(missing_ok=True)


class LocalSavedSessionFiles:
    """Saved-session files for a native language-server process."""

    async def read(self, target: str) -> str | None:
        """Read through the native language-server filesystem."""
        destination = _local_target(target)
        try:
            return await asyncio.to_thread(destination.read_text, encoding="utf-8")
        except FileNotFoundError:
            return None

    async def replace(self, target: str, contents: str) -> None:
        """Replace through a shielded thread without exposing a partial file."""
        destination = _local_target(target)
        temporary, descriptor = _create_local(destination)
        abandoned = threading.Event()
        task = asyncio.create_task(
            asyncio.to_thread(
                _write_local,
                temporary,
                descriptor,
                contents,
                abandoned,
            )
        )
        try:
            await asyncio.shield(task)
        except asyncio.CancelledError:
            abandoned.set()
            task.add_done_callback(_consume_background_result)
            with suppress(OSError):
                os.unlink(temporary)  # noqa: PTH108 - avoid pathlib in async code
            raise
        except BaseException:
            with suppress(OSError):
                os.unlink(temporary)  # noqa: PTH108 - avoid pathlib in async code
            raise
        else:
            try:
                os.replace(temporary, destination)  # noqa: PTH105 - atomic boundary
            except BaseException:
                with suppress(OSError):
                    os.unlink(temporary)  # noqa: PTH108 - async cleanup
                raise


def _consume_background_result(task: asyncio.Task[None]) -> None:
    """Retrieve a shielded worker result after its caller was cancelled."""
    with suppress(BaseException):
        task.result()


class SavedSessionFileCallbacks(Protocol):
    """Host callbacks supplied to the Pyodide language server."""

    def read(self, target: str) -> Awaitable[str | None]:
        """Read one host file when it exists."""
        ...

    def create(self, target: str) -> str:
        """Create one opaque replacement owned by the host."""
        ...

    def write(self, replacement: str, contents: str) -> Awaitable[None]:
        """Write one host-owned replacement."""
        ...

    def commit(self, replacement: str) -> None:
        """Commit one host-owned replacement."""
        ...

    def discard(self, replacement: str) -> None:
        """Discard one host-owned replacement."""
        ...


class CallbackSavedSessionFiles:
    """Adapt JavaScript host callbacks to saved-session files."""

    def __init__(self, callbacks: SavedSessionFileCallbacks) -> None:
        self._callbacks = callbacks

    async def read(self, target: str) -> str | None:
        """Read through the host filesystem callback."""
        return await self._callbacks.read(target)

    async def replace(self, target: str, contents: str) -> None:
        """Atomically replace through the host filesystem callback."""
        replacement = self._callbacks.create(target)
        try:
            await self._callbacks.write(replacement, contents)
            self._callbacks.commit(replacement)
        except BaseException:
            self._callbacks.discard(replacement)
            raise
