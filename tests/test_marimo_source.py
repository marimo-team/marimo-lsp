# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import subprocess
from typing import TYPE_CHECKING

import pytest

from scripts import marimo_source, marimo_version

if TYPE_CHECKING:
    from pathlib import Path


def _policy() -> marimo_version.VersionPolicy:
    version = marimo_version.Version.parse("0.24.2")
    return marimo_version.VersionPolicy(
        bundled_marimo=version,
        kernel_compatibility_floor=version,
        source=marimo_version.Source(kind="tag", value="0.24.2"),
    )


def test_run_uses_shell_for_windows_command_shims(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[tuple[tuple[object, ...], dict[str, object]]] = []

    def run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        calls.append((args, kwargs))
        return subprocess.CompletedProcess("pnpm", 0, stdout="done\n")

    monkeypatch.setattr(marimo_source.sys, "platform", "win32")
    monkeypatch.setattr(marimo_source.subprocess, "run", run)

    output = marimo_source._run(r"C:\tools\pnpm.CMD", "install", capture=True)

    assert output == "done"
    assert calls[0][0] == (r"C:\tools\pnpm.CMD install",)
    assert calls[0][1]["shell"] is True


def test_check_rejects_a_different_revision(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / ".git").mkdir()
    monkeypatch.setattr(marimo_source.marimo_version, "check", _policy)
    monkeypatch.setattr(marimo_source, "_require_command", lambda command: command)
    monkeypatch.setattr(
        marimo_source,
        "_run",
        lambda *args, **_kwargs: "current" if args[-1] == "HEAD" else "expected",
    )

    with pytest.raises(
        marimo_source.SourcePreparationError,
        match=r"Marimo source is at current, expected 0\.24\.2 \(expected\)",
    ):
        marimo_source.check(tmp_path)


def test_check_rejects_a_different_version(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / ".git").mkdir()
    responses = iter(("revision", "revision", "0.24.1"))
    monkeypatch.setattr(marimo_source.marimo_version, "check", _policy)
    monkeypatch.setattr(marimo_source, "_require_command", lambda command: command)
    monkeypatch.setattr(
        marimo_source, "_run", lambda *_args, **_kwargs: next(responses)
    )

    with pytest.raises(
        marimo_source.SourcePreparationError,
        match=r"Marimo source 0\.24\.2 has version 0\.24\.1, expected 0\.24\.2",
    ):
        marimo_source.check(tmp_path)


def test_prepare_cleans_before_building(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / ".git").mkdir()
    commands: list[tuple[str, ...]] = []
    checked: list[Path] = []

    def run(*args: str, **_kwargs: object) -> str:
        commands.append(args)
        return marimo_source.MARIMO_REPOSITORY

    monkeypatch.setattr(marimo_source.marimo_version, "check", _policy)
    monkeypatch.setattr(marimo_source, "_require_command", lambda command: command)
    monkeypatch.setattr(marimo_source, "_run", run)
    monkeypatch.setattr(marimo_source, "check", checked.append)

    marimo_source.prepare(tmp_path)

    assert ("git", "clean", "-ffdx") in commands
    assert commands.index(("git", "clean", "-ffdx")) < commands.index(
        ("pnpm", "install", "--frozen-lockfile")
    )
    assert checked == [tmp_path]
