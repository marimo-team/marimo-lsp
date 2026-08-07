# Copyright 2026 Marimo. All rights reserved.

"""Read, validate, and update the repository's marimo version policy."""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import tomllib
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any, cast

if TYPE_CHECKING:
    from collections.abc import Sequence

ROOT = Path(__file__).parents[1]
PYPROJECT = "pyproject.toml"
LOCKFILE = "uv.lock"
BASE_PACKAGE = "marimo-base"
FULL_PACKAGE = "marimo"
MARIMO_REPOSITORY = "marimo-team/marimo"
VERSION_PATTERN = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
type Json = bool | int | float | str | list[Json] | dict[str, Json] | None


class VersionPolicyError(RuntimeError):
    """Raised when the marimo version policy cannot be satisfied."""


@dataclass(frozen=True, order=True)
class Version:
    """A final marimo release version."""

    major: int
    minor: int
    patch: int

    @classmethod
    def parse(cls, value: str) -> Version:
        """Parse a canonical three-part release version."""
        match = VERSION_PATTERN.fullmatch(value)
        if match is None:
            msg = f"Expected a final X.Y.Z release, received {value!r}"
            raise VersionPolicyError(msg)
        return cls(*(int(part) for part in match.groups()))

    def __str__(self) -> str:
        return f"{self.major}.{self.minor}.{self.patch}"


@dataclass(frozen=True)
class VersionPolicy:
    """The repository's current marimo version policy."""

    bundled_marimo: Version
    kernel_compatibility_floor: Version

    @property
    def source_ref(self) -> str:
        """Return the marimo source tag matching the bundled release."""
        return str(self.bundled_marimo)


def _load_toml(path: Path) -> dict[str, Any]:
    try:
        return tomllib.loads(path.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as error:
        msg = f"Could not read {path}: {error}"
        raise VersionPolicyError(msg) from error


def _bundled_requirement(pyproject: dict[str, Any]) -> tuple[str, Version]:
    dependencies = pyproject.get("project", {}).get("dependencies", [])
    prefix = f"{BASE_PACKAGE}=="
    matches = [
        dependency for dependency in dependencies if dependency.startswith(prefix)
    ]
    if len(matches) != 1:
        msg = f"Expected exactly one exact {BASE_PACKAGE} dependency, found {matches}"
        raise VersionPolicyError(msg)
    requirement = matches[0]
    return requirement, Version.parse(requirement.removeprefix(prefix))


def _kernel_floor(pyproject: dict[str, Any]) -> Version:
    try:
        value = pyproject["tool"]["marimo-lsp"]["minimum-kernel-version"]
    except (KeyError, TypeError) as error:
        msg = "Missing [tool.marimo-lsp].minimum-kernel-version"
        raise VersionPolicyError(msg) from error
    if not isinstance(value, str):
        msg = "[tool.marimo-lsp].minimum-kernel-version must be a string"
        raise VersionPolicyError(msg)
    return Version.parse(value)


def _locked_version(lockfile: dict[str, Any]) -> Version:
    packages = lockfile.get("package", [])
    matches = [package for package in packages if package.get("name") == BASE_PACKAGE]
    if len(matches) != 1:
        msg = f"Expected exactly one locked {BASE_PACKAGE} package"
        raise VersionPolicyError(msg)
    value = matches[0].get("version")
    if not isinstance(value, str):
        msg = f"Locked {BASE_PACKAGE} has no version"
        raise VersionPolicyError(msg)
    return Version.parse(value)


def check(root: Path = ROOT) -> VersionPolicy:
    """Validate and return the repository's marimo version policy."""
    pyproject = _load_toml(root / PYPROJECT)
    _, bundled = _bundled_requirement(pyproject)
    floor = _kernel_floor(pyproject)
    locked = _locked_version(_load_toml(root / LOCKFILE))

    problems: list[str] = []
    if locked != bundled:
        problems.append(f"{LOCKFILE} has {locked}, expected {bundled}")
    if floor > bundled:
        problems.append(
            f"Kernel compatibility floor {floor} exceeds Bundled marimo {bundled}"
        )
    if problems:
        raise VersionPolicyError("; ".join(problems))
    return VersionPolicy(
        bundled_marimo=bundled,
        kernel_compatibility_floor=floor,
    )


def _fetch_json(url: str) -> Json:
    request = urllib.request.Request(  # noqa: S310
        url,
        headers={"Accept": "application/json", "User-Agent": "marimo-lsp"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return cast("Json", json.load(response))
    except (OSError, ValueError, urllib.error.HTTPError) as error:
        msg = f"Could not query {url}: {error}"
        raise VersionPolicyError(msg) from error


def _pypi_versions(distribution: str) -> set[Version]:
    payload = _fetch_json(f"https://pypi.org/pypi/{distribution}/json")
    releases = payload.get("releases") if isinstance(payload, dict) else None
    if not isinstance(releases, dict):
        msg = f"PyPI returned invalid release data for {distribution}"
        raise VersionPolicyError(msg)
    versions: set[Version] = set()
    for value, files in releases.items():
        if (
            not isinstance(value, str)
            or not isinstance(files, list)
            or not files
            or VERSION_PATTERN.fullmatch(value) is None
        ):
            continue
        versions.add(Version.parse(value))
    return versions


def _github_tag_exists(version: Version) -> bool:
    url = f"https://api.github.com/repos/{MARIMO_REPOSITORY}/git/ref/tags/{version}"
    try:
        _fetch_json(url)
    except VersionPolicyError as error:
        cause = error.__cause__
        if isinstance(cause, urllib.error.HTTPError) and cause.code == 404:
            return False
        raise
    return True


def latest_eligible() -> Version:
    """Return the newest release published everywhere marimo-lsp consumes it."""
    candidates = _pypi_versions(FULL_PACKAGE) & _pypi_versions(BASE_PACKAGE)
    for version in sorted(candidates, reverse=True):
        if _github_tag_exists(version):
            return version
    msg = "No release has a GitHub tag and both PyPI distributions"
    raise VersionPolicyError(msg)


def _require_eligible(version: Version) -> None:
    missing: list[str] = []
    if version not in _pypi_versions(FULL_PACKAGE):
        missing.append(f"PyPI {FULL_PACKAGE}")
    if version not in _pypi_versions(BASE_PACKAGE):
        missing.append(f"PyPI {BASE_PACKAGE}")
    if not _github_tag_exists(version):
        missing.append("GitHub tag")
    if missing:
        msg = f"marimo {version} is missing: {', '.join(missing)}"
        raise VersionPolicyError(msg)


def _refresh_lock(root: Path) -> None:
    uv = shutil.which("uv")
    if uv is None:
        msg = "uv is required to update the Bundled marimo"
        raise VersionPolicyError(msg)
    subprocess.run(  # noqa: S603
        [uv, "lock", "--upgrade-package", BASE_PACKAGE],
        cwd=root,
        check=True,
    )


def update(target: Version | None = None, root: Path = ROOT) -> VersionPolicy:
    """Update the Bundled marimo to an eligible release."""
    current = check(root)
    requested = latest_eligible() if target is None else target
    if target is not None:
        _require_eligible(requested)
    if requested == current.bundled_marimo:
        return current

    pyproject_path = root / PYPROJECT
    lockfile_path = root / LOCKFILE
    pyproject_before = pyproject_path.read_text(encoding="utf-8")
    lockfile_before = lockfile_path.read_text(encoding="utf-8")
    requirement, _ = _bundled_requirement(tomllib.loads(pyproject_before))
    replacement = f"{BASE_PACKAGE}=={requested}"
    pyproject_after = pyproject_before.replace(requirement, replacement, 1)
    pyproject_path.write_text(pyproject_after, encoding="utf-8")
    try:
        _refresh_lock(root)
        return check(root)
    except BaseException:
        pyproject_path.write_text(pyproject_before, encoding="utf-8")
        lockfile_path.write_text(lockfile_before, encoding="utf-8")
        raise


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    subparsers.add_parser("show", help="print the Bundled marimo source tag")
    subparsers.add_parser("check", help="validate the repository version policy")
    update_parser = subparsers.add_parser(
        "update", help="update the Bundled marimo release"
    )
    update_parser.add_argument("version", nargs="?", help="release; defaults to latest")
    return parser


def main(argv: Sequence[str] | None = None) -> int:
    """Run the marimo version-policy command."""
    args = _parser().parse_args(argv)
    try:
        if args.command == "show":
            print(check().source_ref)
        elif args.command == "check":
            policy = check()
            print(
                f"Bundled marimo {policy.bundled_marimo}; "
                f"kernel compatibility floor {policy.kernel_compatibility_floor}"
            )
        else:
            target = Version.parse(args.version) if args.version else None
            policy = update(target)
            print(policy.bundled_marimo)
    except (VersionPolicyError, subprocess.CalledProcessError) as error:
        _parser().error(str(error))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
