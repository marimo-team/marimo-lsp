import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { resolveProjectInstallRequests } from "../installPackages.ts";

function makeProject(content: string) {
  const tmp = NodeFs.mkdtempDisposableSync(
    NodePath.join(NodeOs.tmpdir(), "marimo-install-packages-"),
  );
  NodeFs.writeFileSync(NodePath.join(tmp.path, "pyproject.toml"), content);
  return tmp;
}

it.effect(
  "uses the package's unique existing dependency group",
  Effect.fn(function* () {
    using project = makeProject(`
[project]
dependencies = []

[dependency-groups]
notebooks = ["marimo>=0.10"]
`);
    const vscode = yield* TestVsCode.make();

    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    ).pipe(Effect.provide(vscode.layer));

    expect(requests).toEqual([
      {
        packages: ["marimo>=0.20"],
        target: { kind: "group", name: "notebooks" },
      },
    ]);
  }),
);

it.effect(
  "refuses to update only one of multiple declarations",
  Effect.fn(function* () {
    using project = makeProject(`
[project]
dependencies = ["marimo>=0.10"]

[dependency-groups]
dev = ["marimo>=0.10"]
`);
    const vscode = yield* TestVsCode.make();

    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    ).pipe(Effect.provide(vscode.layer));

    expect(requests).toBeNull();
  }),
);

it.effect(
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
    const vscode = yield* TestVsCode.make();

    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    ).pipe(Effect.provide(vscode.layer));

    expect(requests).toBeNull();
  }),
);

it.effect(
  "falls back to project dependencies when TOML inspection fails",
  Effect.fn(function* () {
    using project = makeProject("[project\ndependencies = []");
    const vscode = yield* TestVsCode.make();

    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20"],
      project.path,
    ).pipe(Effect.provide(vscode.layer));

    expect(requests).toEqual([
      {
        packages: ["marimo>=0.20"],
        target: { kind: "production" },
      },
    ]);
  }),
);

it.effect(
  "batches packages that share a target and separates different targets",
  Effect.fn(function* () {
    using project = makeProject(`
[project]
dependencies = ["httpx"]

[dependency-groups]
dev = ["marimo", "pytest"]
`);
    const vscode = yield* TestVsCode.make();

    const requests = yield* resolveProjectInstallRequests(
      ["marimo>=0.20", "pytest", "httpx"],
      project.path,
    ).pipe(Effect.provide(vscode.layer));

    expect(requests).toEqual([
      {
        packages: ["marimo>=0.20", "pytest"],
        target: { kind: "group", name: "dev" },
      },
      {
        packages: ["httpx"],
        target: { kind: "production" },
      },
    ]);
  }),
);
