"""Build a markdown coverage summary for a sticky PR comment.

Reads Python (pytest-cov JSON) and TypeScript (vitest json-summary)
coverage artifacts and prints markdown to stdout.

Usage: python scripts/coverage_comment.py <artifacts-dir>
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def fmt_pct(pct: float | None) -> str:
    if pct is None:
        return "—"
    return f"{pct:.2f}%"


def fmt_ratio(covered: int | None, total: int | None) -> str:
    if covered is None or total is None:
        return "—"
    return f"{covered} / {total}"


def load_python(root: Path) -> dict | None:
    path = root / "python" / "coverage.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    totals = data.get("totals", {})
    covered_lines = totals.get("covered_lines")
    num_statements = totals.get("num_statements")
    covered_branches = totals.get("covered_branches")
    num_branches = totals.get("num_branches")
    return {
        "lines_pct": totals.get("percent_covered"),
        "lines_covered": covered_lines,
        "lines_total": num_statements,
        "branches_pct": (
            (covered_branches / num_branches * 100) if num_branches else None
        ),
        "branches_covered": covered_branches,
        "branches_total": num_branches,
    }


def load_typescript(root: Path) -> dict | None:
    path = root / "typescript" / "coverage-summary.json"
    if not path.exists():
        return None
    data = json.loads(path.read_text())
    total = data.get("total", {})
    lines = total.get("lines", {})
    stmts = total.get("statements", {})
    branches = total.get("branches", {})
    funcs = total.get("functions", {})
    return {
        "lines_pct": lines.get("pct"),
        "lines_covered": lines.get("covered"),
        "lines_total": lines.get("total"),
        "statements_pct": stmts.get("pct"),
        "statements_covered": stmts.get("covered"),
        "statements_total": stmts.get("total"),
        "branches_pct": branches.get("pct"),
        "branches_covered": branches.get("covered"),
        "branches_total": branches.get("total"),
        "functions_pct": funcs.get("pct"),
        "functions_covered": funcs.get("covered"),
        "functions_total": funcs.get("total"),
    }


def main() -> int:
    if len(sys.argv) != 2:
        print("usage: coverage_comment.py <artifacts-dir>", file=sys.stderr)
        return 2
    root = Path(sys.argv[1])
    py = load_python(root)
    ts = load_typescript(root)

    lines = ["## Coverage Report"]

    if py is None and ts is None:
        lines.append("")
        lines.append("No coverage artifacts available.")
        print("\n".join(lines))
        return 0

    lines.append("")
    lines.append("| Area | Lines | Branches | Functions |")
    lines.append("| --- | --- | --- | --- |")

    if py is not None:
        lines.append(
            f"| Python | {fmt_pct(py['lines_pct'])} "
            f"({fmt_ratio(py['lines_covered'], py['lines_total'])}) "
            f"| {fmt_pct(py['branches_pct'])} "
            f"({fmt_ratio(py['branches_covered'], py['branches_total'])}) "
            f"| — |"
        )
    else:
        lines.append("| Python | unavailable | — | — |")

    if ts is not None:
        lines.append(
            f"| TypeScript | {fmt_pct(ts['lines_pct'])} "
            f"({fmt_ratio(ts['lines_covered'], ts['lines_total'])}) "
            f"| {fmt_pct(ts['branches_pct'])} "
            f"({fmt_ratio(ts['branches_covered'], ts['branches_total'])}) "
            f"| {fmt_pct(ts['functions_pct'])} "
            f"({fmt_ratio(ts['functions_covered'], ts['functions_total'])}) |"
        )
    else:
        lines.append("| TypeScript | unavailable | — | — |")

    if ts is not None:
        lines.append("")
        lines.append(
            "<sub>TypeScript statements: "
            f"{fmt_pct(ts['statements_pct'])} "
            f"({fmt_ratio(ts['statements_covered'], ts['statements_total'])})"
            "</sub>"
        )

    print("\n".join(lines))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
