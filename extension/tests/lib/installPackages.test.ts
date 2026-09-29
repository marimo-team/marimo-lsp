import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import { resolveProjectInstallRequests } from "../../src/lib/installPackages.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "./EffectTest.ts";

const it = EffectTest.make(VsCodeTest.layer);

function makeProject(content: string) {
  const tmp = NodeFs.mkdtempDisposableSync(
    NodePath.join(NodeOs.tmpdir(), "marimo-install-packages-"),
  );
  NodeFs.writeFileSync(NodePath.join(tmp.path, "pyproject.toml"), content);
  return tmp;
}

it.live(
  "uses the package's unique existing dependency group",
  Effect.fn(function* () {
    using project = makeProject(`
[project]
dependencies = []

[dependency-groups]
notebooks = ["marimo>=0.10"]
`);
    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    );

    Vitest.expect(requests).toEqual([
      {
        packages: ["marimo>=0.20"],
        target: { _tag: "Group", name: "notebooks" },
      },
    ]);
  }),
);

it.live(
  "refuses to update only one of multiple declarations",
  Effect.fn(function* () {
    using project = makeProject(`
[project]
dependencies = ["marimo>=0.10"]

[dependency-groups]
dev = ["marimo>=0.10"]
`);
    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    );

    Vitest.expect(requests).toBeNull();
  }),
);

it.live(
  "cancels when standard and legacy dev declarations conflict",
  Effect.fn(function* () {
    using project = makeProject(`
[project]
dependencies = []

[dependency-groups]
dev = ["marimo<0.20"]

[tool.uv]
dev-dependencies = ["marimo<0.20"]
`);
    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    );

    Vitest.expect(requests).toBeNull();
  }),
);

it.live(
  "falls back to project dependencies when TOML inspection fails",
  Effect.fn(function* () {
    using project = makeProject("[project\ndependencies = []");
    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    );

    Vitest.expect(requests).toEqual([
      {
        packages: ["marimo>=0.20"],
        target: { _tag: "Production" },
      },
    ]);
  }),
);

it.live(
  "batches packages that share a target and separates different targets",
  Effect.fn(function* () {
    using project = makeProject(`
[project]
dependencies = ["httpx"]

[dependency-groups]
dev = ["marimo", "pytest"]
`);
    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20", "pytest", "httpx"],
      project.path,
    );

    Vitest.expect(requests).toEqual([
      {
        packages: ["marimo>=0.20", "pytest"],
        target: { _tag: "Group", name: "dev" },
      },
      {
        packages: ["httpx"],
        target: { _tag: "Production" },
      },
    ]);
  }),
);
