"""Package manager for marimo LSP integration."""

from __future__ import annotations

import os
import subprocess
from typing import TYPE_CHECKING

from marimo._runtime.packages.utils import sys

if TYPE_CHECKING:
    from marimo._runtime.packages.package_manager import (
        LogCallback,
        PackageDescription,
    )
    from marimo._runtime.packages.package_managers import PackageManager
    from marimo._server.models.packages import DependencyTreeNode


class LspPackageManager:
    """Package manager for marimo LSP integration."""

    def __init__(
        self, *, delegate: PackageManager, venv_location: str | None = None
    ) -> None:
        super().__init__()
        self._delegate = delegate
        self._venv_location = venv_location
        self._delegate.run = self.run
        self._delegate._venv_location = venv_location  # noqa: SLF001

    def dependency_tree(self, filename: str | None = None) -> DependencyTreeNode | None:
        """Get dependency tree for the project."""
        return self._delegate.dependency_tree(filename)

    def list_packages(self) -> list[PackageDescription]:
        """List installed packages."""
        return self._delegate.list_packages()

    # TODO: instead of overriding this, we should extend PackageManager
    # to allow custom env to be passed in
    def run(self, command: list[str], log_callback: LogCallback | None) -> bool:
        """Run a package manager command with optional logging."""
        if not self._delegate.is_manager_installed():
            return False

        if log_callback is None:
            # Original behavior - just run the command without capturing output
            # ruff: noqa: S603
            completed_process = subprocess.run(command, check=False)
            return completed_process.returncode == 0

        env = os.environ.copy()
        # TODO: fix me, use the correct environment variable
        if self._venv_location:
            env["UV_PROJECT_ENVIRONMENT"] = self._venv_location

        # Stream output to both the callback and the terminal
        # ruff: noqa: S603
        proc = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            env=env,
            universal_newlines=False,  # Keep as bytes to preserve ANSI codes
            bufsize=0,  # Unbuffered for real-time output
        )

        if proc.stdout:
            for line in iter(proc.stdout.readline, b""):
                # Send to terminal (original behavior)
                sys.stdout.buffer.write(line)
                sys.stdout.buffer.flush()
                # Send to callback for streaming
                log_callback(line.decode("utf-8", errors="replace"))
            proc.stdout.close()

        return_code = proc.wait()
        return return_code == 0
