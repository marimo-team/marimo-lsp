import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref, Result } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { decodeUvSyncOutput, decodeUvTreeOutput, Uv } from "../../python/Uv.ts";
import { getVenvPythonPath } from "../getVenvPythonPath.ts";
import { ProjectDependencyTarget } from "../ProjectDependencyTarget.ts";

const python = "3.13";
const timeout = 30_000;
const isWindows = NodeProcess.platform === "win32";

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

const UvLive = Layer.empty.pipe(
  Layer.merge(Uv.layer),
  Layer.merge(TmpDir.layer),
  Layer.provide(TestTelemetryLive),
  Layer.provide(TestVsCode.layer),
);

describe("Uv", () => {
  it.effect("does not prompt when optional cache discovery cannot run uv", () =>
    Effect.gen(function* () {
      const prompts = yield* Ref.make(0);
      const missingUv = NodePath.join(NodeOs.tmpdir(), "marimo-lsp-missing-uv");
      const vscode = yield* TestVsCode.make({
        window: {
          showErrorMessage: () =>
            Ref.update(prompts, (count) => count + 1).pipe(
              Effect.as(Option.none()),
            ),
        },
        workspace: {
          getConfiguration: (section) =>
            Effect.succeed({
              // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
              get: <T>(key: string, defaultValue?: T) => {
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                return (
                  section === "marimo.uv" && key === "path"
                    ? missingUv
                    : defaultValue
                ) as T;
              },
              has: (key: string) => section === "marimo.uv" && key === "path",
              inspect: () => undefined,
              async update() {},
            }),
        },
      });
      const layer = Uv.layer.pipe(
        Layer.provide(TestTelemetryLive),
        Layer.provide(vscode.layer),
      );

      const cacheDir = yield* Effect.gen(function* () {
        const uv = yield* Uv;
        return yield* uv.getCacheDirOption;
      }).pipe(Effect.provide(layer));

      expect(Option.isNone(cacheDir)).toBe(true);
      expect(yield* Ref.get(prompts)).toBe(0);
    }),
  );

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should create a new python venv",
      Effect.fn(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;
        const target = NodePath.join(tmpdir.path, ".venv");
        yield* uv.venv(target, { python });
        assert(NodeFs.existsSync(target), "Expected new venv.");
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "returns a stable canonical interpreter across script syncs",
      Effect.fn(function* () {
        const uv = yield* Uv;
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

        expect(created.executable).toBe(getVenvPythonPath(created.environment));
        expect(checked).toEqual(created);
        expect(yield* uv.currentDeps({ script })).toEqual([]);
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should fail `uv add` without pyproject.toml",
      Effect.fn(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;
        const result = yield* Effect.result(
          uv.addProject({ directory: tmpdir.path, packages: ["httpx"] }),
        );
        assert(Result.isFailure(result), "Expected failure");
        assert.strictEqual(result.failure._tag, "UvMissingPyProjectError");
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should preserve custom dependency-group placement with `uv add`",
      Effect.fn(function* () {
        const uv = yield* Uv;
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
        expect(pyproject).toContain("[dependency-groups]");
        expect(pyproject).toMatch(/notebooks = \[\s*"httpx/);
        expect(pyproject).not.toMatch(/dependencies = \[\s*"httpx/);
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should preserve optional-dependency placement with `uv add`",
      Effect.fn(function* () {
        const uv = yield* Uv;
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
        expect(pyproject).toContain("[project.optional-dependencies]");
        expect(pyproject).toMatch(/notebooks = \[\s*"typing-extensions/);
        expect(pyproject).not.toMatch(/dependencies = \[\s*"typing-extensions/);
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should `uv pip install` into venv",
      Effect.fn(function* () {
        const uv = yield* Uv;
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
        assert(
          NodeFs.existsSync(NodePath.join(sitePackages, "httpx")),
          `Expected httpx to be in ${sitePackages}`,
        );
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should `uv init` a new project",
      Effect.fn(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;

        const target = NodePath.join(tmpdir.path, "foo");
        yield* uv.init(target, { python });

        const pyproject = NodePath.join(target, "pyproject.toml");
        assert(NodeFs.existsSync(pyproject), `Expected to create ${pyproject}`);
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should fail with UvResolutionError on conflicting dependencies",
      Effect.fn(function* () {
        const uv = yield* Uv;
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

        assert(Result.isFailure(result), "Expected failure");
        assert.strictEqual(result.failure._tag, "UvResolutionError");
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.effect(
      "should fail with UvMissingPep723MetadataError when script has no metadata",
      Effect.fn(function* () {
        const uv = yield* Uv;
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

        assert(Result.isFailure(result), "Expected failure");
        assert.strictEqual(result.failure._tag, "UvMissingPep723MetadataError");
      }),
      { timeout },
    );
  });

  it.effect("prefers the canonical interpreter reported by the env root", () =>
    Effect.gen(function* () {
      using tmpdir = NodeFs.mkdtempDisposableSync(
        NodePath.join(NodeOs.tmpdir(), "marimo-lsp-uv-output-"),
      );
      const environment = NodePath.join(tmpdir.path, "environment");
      const canonical = getVenvPythonPath(environment);
      NodeFs.mkdirSync(NodePath.dirname(canonical), { recursive: true });
      NodeFs.writeFileSync(canonical, "");
      const reported = NodePath.join(environment, "reported-python");

      const handle = yield* decodeUvSyncOutput(
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

      expect(handle).toEqual({ environment, executable: canonical });
    }),
  );

  it.effect("falls back to uv's reported interpreter", () =>
    Effect.gen(function* () {
      using tmpdir = NodeFs.mkdtempDisposableSync(
        NodePath.join(NodeOs.tmpdir(), "marimo-lsp-uv-output-"),
      );
      const environment = NodePath.join(tmpdir.path, "environment");
      const reported = NodePath.join(environment, "reported-python");

      const handle = yield* decodeUvSyncOutput(
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

      expect(handle).toEqual({ environment, executable: reported });
    }),
  );

  it.effect("decodes only a script's direct package dependencies", () =>
    Effect.gen(function* () {
      const packages = yield* decodeUvTreeOutput(
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

      expect(packages).toEqual([
        { name: "marimo", version: "0.24.0" },
        { name: "polars", version: "1.34.0" },
      ]);
    }),
  );

  it.effect("fails with a typed error when uv JSON is invalid", () =>
    Effect.gen(function* () {
      const result = yield* Effect.result(decodeUvSyncOutput("not json"));
      assert(Result.isFailure(result));
      expect(result.failure._tag).toBe("UvOutputDecodeError");
    }),
  );

  describe("ensureLanguageServerBinaryInstalled", () => {
    const server = { name: "ruff", version: "0.11.4" } as const;

    const singleStrategy = <T extends string>(initial: T) => ({
      initial,
      next: () => Option.none(),
    });

    it.layer(Layer.fresh(UvLive))((it) => {
      it.effect(
        "installs with default strategy",
        Effect.fn(function* () {
          const uv = yield* Uv;
          const tmpdir = yield* TmpDir;
          const targetPath = NodePath.join(tmpdir.path, "default");

          const binPath = yield* uv.ensureLanguageServerBinaryInstalled(
            server,
            { targetPath, policy: singleStrategy("default") },
          );

          assert(NodeFs.existsSync(binPath), `Expected binary at ${binPath}`);
        }),
        { timeout },
      );

      it.effect(
        "installs with native-tls strategy",
        Effect.fn(function* () {
          const uv = yield* Uv;
          const tmpdir = yield* TmpDir;
          const targetPath = NodePath.join(tmpdir.path, "native-tls");

          const binPath = yield* uv.ensureLanguageServerBinaryInstalled(
            server,
            { targetPath, policy: singleStrategy("native-tls") },
          );

          assert(NodeFs.existsSync(binPath), `Expected binary at ${binPath}`);
        }),
        { timeout },
      );

      it.effect(
        "installs with offline strategy",
        Effect.fn(function* () {
          const uv = yield* Uv;
          const tmpdir = yield* TmpDir;
          const targetPath = NodePath.join(tmpdir.path, "offline");

          // First install to cache, then test offline
          yield* uv.ensureLanguageServerBinaryInstalled(server, {
            targetPath: NodePath.join(tmpdir.path, "cache-warmup"),
            policy: singleStrategy("default"),
          });

          const binPath = yield* uv.ensureLanguageServerBinaryInstalled(
            server,
            { targetPath, policy: singleStrategy("offline") },
          );

          assert(NodeFs.existsSync(binPath), `Expected binary at ${binPath}`);
        }),
        { timeout },
      );

      // Simulate a broken .venv in the parent directory (the scenario
      // from VSCODE-MARIMO-2KT where a wrong-arch python.exe causes
      // uv to fail with OS error 193 on Windows).
      it.effect.skipIf(isWindows)(
        "installs even when a broken .venv exists in a parent directory (unix)",
        Effect.fn(function* () {
          const uv = yield* Uv;
          const tmpdir = yield* TmpDir;

          const brokenVenv = NodePath.join(tmpdir.path, ".venv");
          NodeFs.mkdirSync(NodePath.join(brokenVenv, "bin"), {
            recursive: true,
          });
          NodeFs.writeFileSync(
            NodePath.join(brokenVenv, "bin", "python3"),
            "not a real python",
            { mode: 0o755 },
          );
          NodeFs.writeFileSync(
            NodePath.join(brokenVenv, "pyvenv.cfg"),
            "home = /nonexistent\n",
          );

          const targetPath = NodePath.join(tmpdir.path, "libs");
          const binPath = yield* uv.ensureLanguageServerBinaryInstalled(
            server,
            { targetPath, policy: singleStrategy("default") },
          );
          assert(NodeFs.existsSync(binPath), `Expected binary at ${binPath}`);
        }),
        { timeout },
      );

      it.effect.skipIf(!isWindows)(
        "installs even when a broken .venv exists in a parent directory (windows)",
        Effect.fn(function* () {
          const uv = yield* Uv;
          const tmpdir = yield* TmpDir;

          const brokenVenv = NodePath.join(tmpdir.path, ".venv");
          NodeFs.mkdirSync(NodePath.join(brokenVenv, "Scripts"), {
            recursive: true,
          });
          NodeFs.writeFileSync(
            NodePath.join(brokenVenv, "Scripts", "python.exe"),
            "not a real python",
          );
          NodeFs.writeFileSync(
            NodePath.join(brokenVenv, "pyvenv.cfg"),
            "home = /nonexistent\n",
          );

          const targetPath = NodePath.join(tmpdir.path, "libs");
          const binPath = yield* uv.ensureLanguageServerBinaryInstalled(
            server,
            { targetPath, policy: singleStrategy("default") },
          );
          assert(NodeFs.existsSync(binPath), `Expected binary at ${binPath}`);
        }),
        { timeout },
      );

      it.effect(
        "reinstalling with a new version replaces the binary",
        Effect.fn(function* () {
          const uv = yield* Uv;
          const tmpdir = yield* TmpDir;
          const targetPath = NodePath.join(tmpdir.path, "upgrade");

          // Install old version first
          const oldServer = { name: "ruff", version: "0.11.4" } as const;
          yield* uv.ensureLanguageServerBinaryInstalled(oldServer, {
            targetPath,
            policy: singleStrategy("default"),
          });

          // Install new version over it
          const newServer = { name: "ruff", version: "0.11.5" } as const;
          const binPath = yield* uv.ensureLanguageServerBinaryInstalled(
            newServer,
            { targetPath, policy: singleStrategy("default") },
          );

          const output = NodeChildProcess.execSync(`${binPath} --version`, {
            encoding: "utf8",
          });

          expect(output.trim()).toMatchInlineSnapshot(`"ruff 0.11.5"`);
        }),
        { timeout },
      );
    });
  });
});
