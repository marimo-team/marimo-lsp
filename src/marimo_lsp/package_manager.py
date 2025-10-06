import os
import subprocess
from typing import Optional

from marimo._runtime.packages.package_manager import (
    LogCallback,
    PackageDescription,
)
from marimo._runtime.packages.package_managers import PackageManager
from marimo._runtime.packages.utils import sys
from marimo._server.models.packages import DependencyTreeNode


class LspPackageManager(PackageManager):
    def __init__(self, *, delegate: PackageManager, venv_location: str | None = None):
        self._delegate = delegate
        self._venv_location = venv_location

    @property
    def name(self) -> str:
        return self._delegate.name

    @property
    def docs_url(self) -> str:
        return self._delegate.docs_url

    def dependency_tree(self, filename: str | None = None) -> DependencyTreeNode | None:
        return self._delegate.dependency_tree(filename)

    def package_to_module(self, package_name: str) -> str:
        return self._delegate.package_to_module(package_name)

    def module_to_package(self, module_name: str) -> str:
        return self._delegate.module_to_package(module_name)

    def uninstall(self, package: str) -> bool:
        return self._delegate.uninstall(package)

    def _install(
        self,
        package: str,
        version: Optional[str] = None,
        upgrade: bool = False,
        log_callback: Optional[LogCallback] = None,
    ) -> bool:
        return self._delegate._install(package, version, upgrade, log_callback)

    def list_packages(self) -> list[PackageDescription]:
        return self._delegate.list_packages()

    # TODO: instead of overriding this, we should extend PackageManager to allow custom env to
    # be passed in
    def run(self, command: list[str], log_callback: Optional[LogCallback]) -> bool:
        if not self.is_manager_installed():
            return False

        if log_callback is None:
            # Original behavior - just run the command without capturing   output
            completed_process = subprocess.run(command, check=False)
            return completed_process.returncode == 0

        env = os.environ.copy()
        # TODO: fix me, use the correct environment variable
        if self._venv_location:
            env["UV_PROJECT_ENVIRONMENT"] = self._venv_location

        # Stream output to both the callback and the terminal
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
