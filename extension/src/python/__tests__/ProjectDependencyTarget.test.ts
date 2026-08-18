import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { inspectProjectDependencies } from "../ProjectDependencyTarget.ts";

function withProject(content: string, test: (directory: string) => void) {
  using tmp = NodeFs.mkdtempDisposableSync(
    NodePath.join(NodeOs.tmpdir(), "marimo-project-target-"),
  );
  NodeFs.writeFileSync(NodePath.join(tmp.path, "pyproject.toml"), content);
  test(tmp.path);
}

const findTargets = (directory: string, requirement: string) =>
  inspectProjectDependencies(directory).findTargets(requirement);

describe("inspectProjectDependencies", () => {
  it("finds production, optional, and arbitrary dependency groups", () => {
    withProject(
      `
[project]
dependencies = ["marimo[sql]>=0.10"]

[project.optional-dependencies]
notebooks = ["marimo>=0.11"]

[dependency-groups]
dev = ["marimo>=0.12"]
docs = ["marimo>=0.13"]
`,
      (directory) => {
        expect(findTargets(directory, "marimo>=0.20")).toEqual([
          { _tag: "Production" },
          { _tag: "Optional", name: "notebooks" },
          { _tag: "Group", name: "dev" },
          { _tag: "Group", name: "docs" },
        ]);
      },
    );
  });

  it("finds a direct dependency in a nested group, not its includer", () => {
    withProject(
      `
[project]
dependencies = []

[dependency-groups]
dev = [{ include-group = "notebooks" }]
notebooks = ["marimo>=0.10"]
`,
      (directory) => {
        expect(findTargets(directory, "marimo")).toEqual([
          { _tag: "Group", name: "notebooks" },
        ]);
      },
    );
  });

  it("maps legacy uv dev dependencies to the dev group", () => {
    withProject(
      `
[project]
dependencies = []

[tool.uv]
dev-dependencies = ["marimo>=0.10"]
`,
      (directory) => {
        expect(findTargets(directory, "marimo")).toEqual([
          { _tag: "Group", name: "dev" },
        ]);
      },
    );
  });

  it("does not duplicate dev when legacy and standard declarations coexist", () => {
    withProject(
      `
[project]
dependencies = []

[dependency-groups]
dev = ["marimo>=0.10"]

[tool.uv]
dev-dependencies = ["marimo>=0.10"]
`,
      (directory) => {
        expect(findTargets(directory, "marimo")).toEqual([
          { _tag: "Group", name: "dev" },
        ]);
      },
    );
  });

  it("reports matching legacy and standard dev declarations", () => {
    withProject(
      `
[project]
dependencies = []

[dependency-groups]
dev = ["marimo>=0.10"]

[tool.uv]
dev-dependencies = ["marimo>=0.10"]
`,
      (directory) => {
        const inspection = inspectProjectDependencies(directory);
        expect(inspection.hasDuplicateDevDeclaration("marimo>=0.20")).toBe(
          true,
        );
      },
    );
  });

  it("uses a single project snapshot for multiple package lookups", () => {
    withProject(
      `
[project]
dependencies = ["httpx"]

[dependency-groups]
dev = ["marimo"]
`,
      (directory) => {
        const inspection = inspectProjectDependencies(directory);
        NodeFs.writeFileSync(
          NodePath.join(directory, "pyproject.toml"),
          "[invalid",
        );

        expect(inspection.findTargets("httpx")).toEqual([
          { _tag: "Production" },
        ]);
        expect(inspection.findTargets("marimo")).toEqual([
          { _tag: "Group", name: "dev" },
        ]);
      },
    );
  });

  it("normalizes distribution names", () => {
    withProject(
      `
[project]
dependencies = []

[dependency-groups]
dev = ["My.Package_Name>=1"]
`,
      (directory) => {
        expect(findTargets(directory, "my-package-name>=2")).toEqual([
          { _tag: "Group", name: "dev" },
        ]);
      },
    );
  });

  it("searches parent directories from the virtual environment", () => {
    withProject(
      `
[project]
dependencies = []

[dependency-groups]
test = ["marimo"]
`,
      (directory) => {
        const venv = NodePath.join(directory, ".venv", "nested");
        NodeFs.mkdirSync(venv, { recursive: true });
        expect(findTargets(venv, "marimo")).toEqual([
          { _tag: "Group", name: "test" },
        ]);
      },
    );
  });

  it("returns no targets without a pyproject or direct declaration", () => {
    using tmp = NodeFs.mkdtempDisposableSync(
      NodePath.join(NodeOs.tmpdir(), "marimo-project-target-"),
    );
    expect(findTargets(tmp.path, "marimo")).toEqual([]);
  });

  it("rejects malformed TOML", () => {
    withProject("[project\ndependencies = []", (directory) => {
      expect(() => findTargets(directory, "marimo")).toThrow();
    });
  });
});
