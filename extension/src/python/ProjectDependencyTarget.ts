import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import { parse } from "@std/toml";
import { Data } from "effect";

export type ProjectDependencyTarget = Data.TaggedEnum<{
  Production: {};
  Group: { readonly name: string };
  Optional: { readonly name: string };
}>;

export const ProjectDependencyTarget =
  Data.taggedEnum<ProjectDependencyTarget>();

export type ProjectDependencyInspection = {
  readonly findTargets: (
    requirement: string,
  ) => ReadonlyArray<ProjectDependencyTarget>;
  readonly hasDuplicateDevDeclaration: (requirement: string) => boolean;
};

/**
 * Read and index the nearest pyproject once for a package-install batch.
 *
 * uv only updates the dependency field selected by `--group` / `--optional`;
 * an unqualified `uv add` always targets `project.dependencies`. Inspecting the
 * existing declarations lets us preserve the user's chosen location.
 */
export function inspectProjectDependencies(
  directory: string,
): ProjectDependencyInspection {
  const pyproject = findPyProject(directory);
  if (pyproject == null) {
    return {
      findTargets: () => [],
      hasDuplicateDevDeclaration: () => false,
    };
  }

  const document = parse(NodeFs.readFileSync(pyproject, "utf8"));
  const project = asTable(document.project);
  const legacyDevDependencies = asTable(asTable(document.tool)?.uv)?.[
    "dev-dependencies"
  ];
  const dependencyGroups = asTable(document["dependency-groups"]) ?? {};
  const standardDevDependencies = dependencyGroups.dev;

  return {
    findTargets(requirement) {
      const packageName = parseRequirementName(requirement);
      if (packageName == null) return [];

      const targets: ProjectDependencyTarget[] = [];
      if (containsPackage(project?.dependencies, packageName)) {
        targets.push(ProjectDependencyTarget.Production());
      }

      for (const [name, dependencies] of Object.entries(
        asTable(project?.["optional-dependencies"]) ?? {},
      )) {
        if (containsPackage(dependencies, packageName)) {
          targets.push(ProjectDependencyTarget.Optional({ name }));
        }
      }

      for (const [name, dependencies] of Object.entries(dependencyGroups)) {
        if (containsPackage(dependencies, packageName)) {
          targets.push(ProjectDependencyTarget.Group({ name }));
        }
      }

      // uv preserves this legacy field when `--dev` is used. Treat it as the
      // dev group when there is no matching standard declaration.
      if (
        containsPackage(legacyDevDependencies, packageName) &&
        !containsPackage(standardDevDependencies, packageName)
      ) {
        targets.push(ProjectDependencyTarget.Group({ name: "dev" }));
      }

      return targets;
    },
    hasDuplicateDevDeclaration(requirement) {
      const packageName = parseRequirementName(requirement);
      return (
        packageName != null &&
        containsPackage(standardDevDependencies, packageName) &&
        containsPackage(legacyDevDependencies, packageName)
      );
    },
  };
}

export function formatProjectDependencyTarget(
  target: ProjectDependencyTarget,
): string {
  return ProjectDependencyTarget.$match(target, {
    Production: () => "Project dependencies",
    Group: ({ name }) => `Dependency group: ${name}`,
    Optional: ({ name }) => `Optional dependency: ${name}`,
  });
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
