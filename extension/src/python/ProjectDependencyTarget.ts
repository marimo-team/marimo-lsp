import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { parse } from "@std/toml";

import { unreachable } from "../assert.ts";

export type ProjectDependencyTarget =
  | { readonly kind: "production" }
  | { readonly kind: "group"; readonly name: string }
  | { readonly kind: "optional"; readonly name: string };

const PRODUCTION_TARGET = { kind: "production" } as const;

/**
 * Find every pyproject location in which a package is declared directly.
 *
 * uv only updates the dependency field selected by `--group` / `--optional`;
 * an unqualified `uv add` always targets `project.dependencies`. Inspecting the
 * existing declarations lets us preserve the user's chosen location.
 */
export function findProjectDependencyTargets(
  directory: string,
  requirement: string,
): ReadonlyArray<ProjectDependencyTarget> {
  const pyproject = findPyProject(directory);
  if (pyproject == null) return [];

  const packageName = parseRequirementName(requirement);
  if (packageName == null) return [];

  const document = parse(NodeFs.readFileSync(pyproject, "utf8"));
  const targets: ProjectDependencyTarget[] = [];
  const project = asTable(document.project);

  if (containsPackage(project?.dependencies, packageName)) {
    targets.push(PRODUCTION_TARGET);
  }

  for (const [name, dependencies] of Object.entries(
    asTable(project?.["optional-dependencies"]) ?? {},
  )) {
    if (containsPackage(dependencies, packageName)) {
      targets.push({ kind: "optional", name });
    }
  }

  for (const [name, dependencies] of Object.entries(
    asTable(document["dependency-groups"]) ?? {},
  )) {
    if (containsPackage(dependencies, packageName)) {
      targets.push({ kind: "group", name });
    }
  }

  // uv preserves this legacy field when `--dev` is used. Treat it as the dev
  // group, while avoiding a duplicate if both old and new fields are present.
  const legacyDevDependencies = asTable(asTable(document.tool)?.uv)?.[
    "dev-dependencies"
  ];
  if (
    containsPackage(legacyDevDependencies, packageName) &&
    !targets.some((target) => target.kind === "group" && target.name === "dev")
  ) {
    targets.push({ kind: "group", name: "dev" });
  }

  return targets;
}

export function formatProjectDependencyTarget(
  target: ProjectDependencyTarget,
): string {
  switch (target.kind) {
    case "production":
      return "Project dependencies";
    case "group":
      return `Dependency group: ${target.name}`;
    case "optional":
      return `Optional dependency: ${target.name}`;
  }
  return unreachable(target);
}

function findPyProject(directory: string): string | null {
  let current = NodePath.resolve(directory);
  while (true) {
    const candidate = NodePath.join(current, "pyproject.toml");
    if (NodeFs.existsSync(candidate)) return candidate;

    const parent = NodePath.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function containsPackage(value: unknown, packageName: string): boolean {
  return (
    Array.isArray(value) &&
    value.some(
      (requirement) =>
        typeof requirement === "string" &&
        parseRequirementName(requirement) === packageName,
    )
  );
}

/** Normalize a PEP 508 distribution name according to the packaging spec. */
function parseRequirementName(requirement: string): string | null {
  const match = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/.exec(
    requirement,
  );
  return match?.[1]?.toLowerCase().replaceAll(/[._-]+/g, "-") ?? null;
}

function asTable(value: unknown): Record<string, unknown> | null {
  return isTable(value) ? value : null;
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}
