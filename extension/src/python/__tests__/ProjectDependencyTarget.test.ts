import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  findProjectDependencyTargets,
  inspectProjectDependencies,
} from "../ProjectDependencyTarget.ts";

function withProject(content: string, test: (directory: string) => void) {
  using tmp = NodeFs.mkdtempDisposableSync(
    NodePath.join(NodeOs.tmpdir(), "marimo-project-target-"),
  );
  NodeFs.writeFileSync(NodePath.join(tmp.path, "pyproject.toml"), content);
  test(tmp.path);
}

describe("findProjectDependencyTargets", () => {
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
        expect(findProjectDependencyTargets(directory, "marimo>=0.20")).toEqual(
          [
            { kind: "production" },
            { kind: "optional", name: "notebooks" },
            { kind: "group", name: "dev" },
            { kind: "group", name: "docs" },
          ],
        );
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
        expect(findProjectDependencyTargets(directory, "marimo")).toEqual([
          { kind: "group", name: "notebooks" },
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
        expect(findProjectDependencyTargets(directory, "marimo")).toEqual([
          { kind: "group", name: "dev" },
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
        expect(findProjectDependencyTargets(directory, "marimo")).toEqual([
          { kind: "group", name: "dev" },
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
          { kind: "production" },
        ]);
        expect(inspection.findTargets("marimo")).toEqual([
          { kind: "group", name: "dev" },
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
        expect(
          findProjectDependencyTargets(directory, "my-package-name>=2"),
        ).toEqual([{ kind: "group", name: "dev" }]);
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
        expect(findProjectDependencyTargets(venv, "marimo")).toEqual([
          { kind: "group", name: "test" },
        ]);
      },
    );
  });

  it("returns no targets without a pyproject or direct declaration", () => {
    using tmp = NodeFs.mkdtempDisposableSync(
      NodePath.join(NodeOs.tmpdir(), "marimo-project-target-"),
    );
    expect(findProjectDependencyTargets(tmp.path, "marimo")).toEqual([]);
  });

  it("rejects malformed TOML", () => {
    withProject("[project\ndependencies = []", (directory) => {
      expect(() => findProjectDependencyTargets(directory, "marimo")).toThrow();
    });
  });
});
