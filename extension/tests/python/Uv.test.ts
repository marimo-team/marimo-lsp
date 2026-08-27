import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer, Option, Result } from "effect";

import { getVenvPythonPath } from "../../src/python/getVenvPythonPath.ts";
import { ProjectDependencyTarget } from "../../src/python/ProjectDependencyTarget.ts";
import * as Uv from "../../src/python/Uv.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const python = "3.13";
const timeout = 30_000;

class TmpDir extends Context.Service<TmpDir>()("TmpDir", {
  make: Effect.gen(function* () {
    const disposable = yield* Effect.acquireRelease(
      Effect.sync(() => {
        return NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-"),
        );
      }),
      (disposable) => Effect.sync(() => disposable.remove()),
    );
    return {
      path: disposable.path,
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

const layer = Layer.empty.pipe(
  Layer.merge(Uv.layer),
  Layer.merge(TmpDir.layer),
  Layer.provide(TelemetryTest.layer),
  Layer.provide(VsCodeTest.layer),
);

Vitest.describe("Uv", () => {
  const it = EffectTest.make(layer);
  it.live(
    "should create a new python venv",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;
      const target = NodePath.join(tmpdir.path, ".venv");
      yield* uv.venv(target, { python });
      Vitest.assert(NodeFs.existsSync(target), "Expected new venv.");
    }),
    { timeout },
  );

  it.live(
    "should fail `uv add` without pyproject.toml",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;
      const result = yield* Effect.result(
        uv.addProject({ directory: tmpdir.path, packages: ["httpx"] }),
      );
      Vitest.assert(Result.isFailure(result), "Expected failure");
      Vitest.assert.strictEqual(
        result.failure._tag,
        "Uv.MissingPyProjectError",
      );
    }),
    { timeout },
  );

  it.live(
    "should preserve custom dependency-group placement with `uv add`",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;
      yield* uv.init(tmpdir.path, { python });

      yield* uv.addProject({
        directory: tmpdir.path,
        packages: ["httpx"],
        target: ProjectDependencyTarget.Group({ name: "notebooks" }),
      });

      const pyproject = NodeFs.readFileSync(
        NodePath.join(tmpdir.path, "pyproject.toml"),
        "utf8",
      );
      Vitest.expect(pyproject).toContain("[dependency-groups]");
      Vitest.expect(pyproject).toMatch(/notebooks = \[\s*"httpx/);
      Vitest.expect(pyproject).not.toMatch(/dependencies = \[\s*"httpx/);
    }),
    { timeout },
  );

  it.live(
    "should preserve optional-dependency placement with `uv add`",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;
      yield* uv.init(tmpdir.path, { python });

      yield* uv.addProject({
        directory: tmpdir.path,
        packages: ["typing-extensions"],
        target: ProjectDependencyTarget.Optional({ name: "notebooks" }),
      });

      const pyproject = NodeFs.readFileSync(
        NodePath.join(tmpdir.path, "pyproject.toml"),
        "utf8",
      );
      Vitest.expect(pyproject).toContain("[project.optional-dependencies]");
      Vitest.expect(pyproject).toMatch(/notebooks = \[\s*"typing-extensions/);
      Vitest.expect(pyproject).not.toMatch(
        /dependencies = \[\s*"typing-extensions/,
      );
    }),
    { timeout },
  );

  it.live(
    "should `uv pip install` into venv",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;
      const venv = NodePath.join(tmpdir.path, ".venv");
      yield* uv.venv(venv, { python });

      yield* uv.pipInstall(["httpx"], { venv });
      // On Windows, site-packages is in Lib/site-packages (no python version)
      // On Unix, it's in lib/pythonX.Y/site-packages
      const sitePackages =
        process.platform === "win32"
          ? NodePath.join(venv, "Lib", "site-packages")
          : NodePath.join(venv, "lib", `python${python}`, "site-packages");
      Vitest.assert(
        NodeFs.existsSync(NodePath.join(sitePackages, "httpx")),
        `Expected httpx to be in ${sitePackages}`,
      );
    }),
    { timeout },
  );

  it.live(
    "should `uv init` a new project",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;

      const target = NodePath.join(tmpdir.path, "foo");
      yield* uv.init(target, { python });

      const pyproject = NodePath.join(target, "pyproject.toml");
      Vitest.assert(
        NodeFs.existsSync(pyproject),
        `Expected to create ${pyproject}`,
      );
    }),
    { timeout },
  );

  it.live(
    "should fail with ResolutionError on conflicting dependencies",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;

      // Create a script with conflicting dependencies
      const script = NodePath.join(tmpdir.path, "conflict.py");
      NodeFs.writeFileSync(
        script,
        `\
# /// script
# requires-python = ">=3.13"
# dependencies = ["pydantic>=2", "pydantic<2"]
# ///

print("This should fail to sync")
`,
        { encoding: "utf8" },
      );

      // Attempt to sync the script, which should fail with resolution error
      const result = yield* Effect.result(uv.syncScript({ script }));

      Vitest.assert(Result.isFailure(result), "Expected failure");
      Vitest.assert.strictEqual(result.failure._tag, "Uv.ResolutionError");
    }),
    { timeout },
  );

  it.live(
    "should fail with MissingPep723MetadataError when script has no metadata",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;

      // Create a script without PEP 723 metadata
      const script = NodePath.join(tmpdir.path, "no-metadata.py");
      NodeFs.writeFileSync(
        script,
        `\
print("This script has no PEP 723 metadata")
`,
        { encoding: "utf8" },
      );

      // Attempt to get current deps, which should fail
      const result = yield* Effect.result(uv.currentDeps({ script }));

      Vitest.assert(Result.isFailure(result), "Expected failure");
      Vitest.assert.strictEqual(
        result.failure._tag,
        "Uv.MissingPep723MetadataError",
      );
    }),
    { timeout },
  );

  it.live(
    "returns a stable canonical interpreter across script syncs",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const tmpdir = yield* TmpDir;
      const script = NodePath.join(tmpdir.path, "notebook.py");
      NodeFs.writeFileSync(
        script,
        `\
# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///
`,
        { encoding: "utf8" },
      );

      const created = yield* uv.syncScript({ script });
      const checked = yield* uv.syncScript({ script });

      Vitest.expect(created.executable).toBe(
        getVenvPythonPath(created.environment),
      );
      Vitest.expect(checked).toEqual(created);
      Vitest.expect(yield* uv.currentDeps({ script })).toEqual([]);
    }),
    { timeout },
  );
  Vitest.it.live(
    "prefers the canonical interpreter reported by the env root",
    () =>
      Effect.gen(function* () {
        using tmpdir = NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-uv-output-"),
        );
        const environment = NodePath.join(tmpdir.path, "environment");
        const canonical = getVenvPythonPath(environment);
        NodeFs.mkdirSync(NodePath.dirname(canonical), { recursive: true });
        NodeFs.writeFileSync(canonical, "");
        const reported = NodePath.join(environment, "reported-python");

        const handle = yield* Uv.decodeUvSyncOutput(
          JSON.stringify({
            schema: { version: "preview" },
            sync: {
              environment: {
                path: environment,
                python: { path: reported },
              },
            },
          }),
        );

        Vitest.expect(handle).toEqual({ environment, executable: canonical });
      }),
  );

  Vitest.it.live("falls back to uv's reported interpreter", () =>
    Effect.gen(function* () {
      using tmpdir = NodeFs.mkdtempDisposableSync(
        NodePath.join(NodeOs.tmpdir(), "marimo-lsp-uv-output-"),
      );
      const environment = NodePath.join(tmpdir.path, "environment");
      const reported = NodePath.join(environment, "reported-python");

      const handle = yield* Uv.decodeUvSyncOutput(
        JSON.stringify({
          schema: { version: "preview" },
          sync: {
            environment: {
              path: environment,
              python: { path: reported },
            },
          },
        }),
      );

      Vitest.expect(handle).toEqual({ environment, executable: reported });
    }),
  );

  Vitest.it.effect("decodes only a script's direct package dependencies", () =>
    Effect.gen(function* () {
      const packages = yield* Uv.decodeUvTreeOutput(
        JSON.stringify({
          schema: { version: "preview" },
          script: { id: "script" },
          resolution: {
            script: {
              kind: "script",
              dependencies: [{ id: "marimo" }, { id: "polars" }],
            },
            marimo: {
              kind: "package",
              name: "marimo",
              version: "0.24.0",
              dependencies: [{ id: "click" }],
            },
            polars: {
              kind: "package",
              name: "polars",
              version: "1.34.0",
              dependencies: [],
            },
            click: {
              kind: "package",
              name: "click",
              version: "8.2.1",
              dependencies: [],
            },
          },
        }),
      );

      Vitest.expect(packages).toEqual([
        { name: "marimo", version: "0.24.0" },
        { name: "polars", version: "1.34.0" },
      ]);
    }),
  );

  Vitest.it.effect("fails with a typed error when uv JSON is invalid", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(Uv.decodeUvSyncOutput("not json"));
      Vitest.assert(Result.isFailure(result));
      Vitest.expect(result.failure._tag).toBe("Uv.OutputDecodeError");
    }),
  );
});

Vitest.describe("optional uv discovery", () => {
  const it = EffectTest.make(
    Uv.layer.pipe(
      Layer.provide(TelemetryTest.layer),
      Layer.provideMerge(
        VsCodeTest.layerWith(
          {},
          {
            workspace: {
              getConfiguration: (section) =>
                Effect.succeed({
                  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
                  get: <T>(key: string, defaultValue?: T) => {
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                    return (
                      section === "marimo.uv" && key === "path"
                        ? NodePath.join(
                            NodeOs.tmpdir(),
                            "marimo-lsp-missing-uv",
                          )
                        : defaultValue
                    ) as T;
                  },
                  has: (key: string) =>
                    section === "marimo.uv" && key === "path",
                  inspect: () => undefined,
                  async update() {},
                }),
            },
          },
        ),
      ),
    ),
  );
  it.live(
    "does not prompt when optional cache discovery cannot run uv",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const code = yield* VsCodeTest.Service;
      Vitest.expect(Option.isNone(yield* uv.getCacheDirOption)).toBe(true);
      Vitest.expect((yield* code.snapshot).errorMessages).toEqual([]);
    }),
  );
});
