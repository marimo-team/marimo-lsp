# Copyright 2026 Marimo. All rights reserved.

"""Prepare the pinned Marimo source checkout used by the extension."""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from typing import TYPE_CHECKING

from scripts import marimo_version

if TYPE_CHECKING:
    from pathlib import Path

MARIMO_REPOSITORY = f"https://github.com/{marimo_version.MARIMO_REPOSITORY}.git"
CHECKOUT = marimo_version.ROOT / ".cache" / "marimo"


class SourcePreparationError(RuntimeError):
    """Raised when the pinned Marimo checkout cannot be prepared."""


def _run(*args: str, cwd: Path = marimo_version.ROOT, capture: bool = False) -> str:
    shell = sys.platform == "win32" and args[0].casefold().endswith((".cmd", ".bat"))
    command: tuple[str, ...] | str = subprocess.list2cmdline(args) if shell else args
    completed = subprocess.run(  # noqa: S603
        command,
        cwd=cwd,
        check=True,
        shell=shell,
        text=True,
        stdout=subprocess.PIPE if capture else None,
    )
    return completed.stdout.strip() if completed.stdout is not None else ""


def _require_command(command: str) -> str:
    executable = shutil.which(command)
    if executable is None:
        msg = f"{command} is required to prepare Marimo source"
        raise SourcePreparationError(msg)
    return executable


def check(checkout: Path = CHECKOUT) -> None:
    """Verify that the prepared checkout matches the configured source."""
    policy = marimo_version.check()
    git = _require_command("git")
    uv = _require_command("uv")
    if not (checkout / ".git").is_dir():
        msg = "Marimo source is not prepared; run 'just setup'"
        raise SourcePreparationError(msg)

    head = _run(git, "rev-parse", "HEAD", cwd=checkout, capture=True)
    expected = _run(
        git,
        "rev-parse",
        f"{policy.source_ref}^{{commit}}",
        cwd=checkout,
        capture=True,
    )
    if head != expected:
        msg = f"Marimo source is at {head}, expected {policy.source_ref} ({expected})"
        raise SourcePreparationError(msg)

    version = _run(
        uv,
        "--project",
        str(checkout),
        "version",
        "--short",
        capture=True,
    )
    if version != str(policy.bundled_marimo):
        msg = (
            f"Marimo source {policy.source_ref} has version {version}, "
            f"expected {policy.bundled_marimo}"
        )
        raise SourcePreparationError(msg)


def prepare(checkout: Path = CHECKOUT) -> None:
    """Create and build the repository-owned checkout at its configured ref."""
    policy = marimo_version.check()
    git = _require_command("git")
    pnpm = _require_command("pnpm")

    checkout.parent.mkdir(parents=True, exist_ok=True)
    git_directory = checkout / ".git"
    if checkout.exists() and not git_directory.is_dir():
        msg = f"Refusing to replace non-Git path {checkout}"
        raise SourcePreparationError(msg)
    if not git_directory.is_dir():
        _run(
            git,
            "clone",
            "--depth=1",
            "--filter=blob:none",
            "--no-checkout",
            MARIMO_REPOSITORY,
            str(checkout),
        )

    origin = _run(git, "remote", "get-url", "origin", cwd=checkout, capture=True)
    if origin != MARIMO_REPOSITORY:
        msg = f"Marimo checkout has unexpected origin {origin}"
        raise SourcePreparationError(msg)

    _run(
        git,
        "fetch",
        "--depth=1",
        "--force",
        "origin",
        policy.source_ref,
        cwd=checkout,
    )
    _run(git, "checkout", "--detach", "--force", "FETCH_HEAD", cwd=checkout)
    _run(git, "reset", "--hard", "FETCH_HEAD", cwd=checkout)
    _run(git, "clean", "-ffdx", cwd=checkout)

    _run(pnpm, "install", "--frozen-lockfile", cwd=checkout)
    _run(
        pnpm,
        "--recursive",
        "--filter",
        "./packages/*",
        "codegen",
        cwd=checkout,
    )
    _run(
        pnpm,
        "--recursive",
        "--filter",
        "./packages/*",
        "build",
        cwd=checkout,
    )
    check(checkout)


def main() -> None:
    """Prepare or check the configured source checkout."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="only verify the checkout")
    args = parser.parse_args()
    try:
        if args.check:
            check()
        else:
            prepare()
    except (SourcePreparationError, subprocess.CalledProcessError) as error:
        parser.error(str(error))


if __name__ == "__main__":
    main()
