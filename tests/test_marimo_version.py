# Copyright 2026 Marimo. All rights reserved.

from __future__ import annotations

import tomllib
from typing import TYPE_CHECKING

import pytest

from scripts import marimo_version

if TYPE_CHECKING:
    from pathlib import Path


def _repository(
    tmp_path: Path,
    *,
    bundled: str = "0.23.16",
    floor: str = "0.23.3",
    locked: str = "0.23.16",
) -> Path:
    (tmp_path / "pyproject.toml").write_text(
        f"""
[project]
dependencies = ["marimo-base=={bundled}"]

[tool.marimo-lsp]
minimum-kernel-version = "{floor}"
""".lstrip(),
        encoding="utf-8",
    )
    (tmp_path / "uv.lock").write_text(
        f"""
version = 1

[[package]]
name = "marimo-base"
version = "{locked}"
""".lstrip(),
        encoding="utf-8",
    )
    return tmp_path


def test_check_reads_the_policy(tmp_path: Path) -> None:
    policy = marimo_version.check(_repository(tmp_path))

    assert str(policy.bundled_marimo) == "0.23.16"
    assert str(policy.kernel_compatibility_floor) == "0.23.3"
    assert policy.source_ref == "0.23.16"


def test_check_rejects_lockfile_drift(tmp_path: Path) -> None:
    root = _repository(tmp_path, locked="0.23.15")

    with pytest.raises(
        marimo_version.VersionPolicyError,
        match=r"uv\.lock has 0\.23\.15",
    ):
        marimo_version.check(root)


def test_check_rejects_floor_above_bundled_version(tmp_path: Path) -> None:
    root = _repository(tmp_path, bundled="0.23.3", floor="0.23.4", locked="0.23.3")

    with pytest.raises(
        marimo_version.VersionPolicyError,
        match=r"compatibility floor 0\.23\.4 exceeds Bundled marimo 0\.23\.3",
    ):
        marimo_version.check(root)


def test_latest_eligible_intersects_distributions_and_tags(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        marimo_version,
        "_pypi_versions",
        lambda _distribution: {
            marimo_version.Version.parse("0.23.16"),
            marimo_version.Version.parse("0.23.17"),
        },
    )
    monkeypatch.setattr(
        marimo_version,
        "_github_tag_exists",
        lambda version: str(version) == "0.23.16",
    )

    assert str(marimo_version.latest_eligible()) == "0.23.16"


def test_update_changes_dependency_and_refreshes_lock(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _repository(tmp_path)
    target = marimo_version.Version.parse("0.23.17")
    monkeypatch.setattr(marimo_version, "_require_eligible", lambda _version: None)

    def refresh_lock(repository: Path) -> None:
        lockfile = repository / "uv.lock"
        source = lockfile.read_text(encoding="utf-8")
        lockfile.write_text(source.replace("0.23.16", "0.23.17"), encoding="utf-8")

    monkeypatch.setattr(marimo_version, "_refresh_lock", refresh_lock)

    policy = marimo_version.update(target, root)

    assert policy.bundled_marimo == target
    pyproject = tomllib.loads((root / "pyproject.toml").read_text(encoding="utf-8"))
    assert pyproject["project"]["dependencies"] == ["marimo-base==0.23.17"]


def test_update_restores_files_when_locking_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = _repository(tmp_path)
    before = {
        path.name: path.read_text(encoding="utf-8")
        for path in (root / "pyproject.toml", root / "uv.lock")
    }
    monkeypatch.setattr(marimo_version, "_require_eligible", lambda _version: None)

    def fail_lock(repository: Path) -> None:
        (repository / "uv.lock").write_text("partial", encoding="utf-8")
        message = "lock failed"
        raise RuntimeError(message)

    monkeypatch.setattr(marimo_version, "_refresh_lock", fail_lock)

    with pytest.raises(RuntimeError, match="lock failed"):
        marimo_version.update(marimo_version.Version.parse("0.23.17"), root)

    assert {
        path.name: path.read_text(encoding="utf-8")
        for path in (root / "pyproject.toml", root / "uv.lock")
    } == before
