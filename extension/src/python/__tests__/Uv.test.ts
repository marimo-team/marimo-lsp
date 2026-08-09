import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer, Option } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { resolveScriptEnvironmentPath, Uv } from "../../python/Uv.ts";
import { ProjectDependencyTarget } from "../ProjectDependencyTarget.ts";

const python = "3.13";
const timeout = 30_000;
const isWindows = NodeProcess.platform === "win32";

class TmpDir extends Effect.Service<TmpDir>()("TmpDir", {
  scoped: Effect.gen(function* () {
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
}) {}

const UvLive = Layer.empty.pipe(
  Layer.merge(Uv.Default),
  Layer.merge(TmpDir.Default),
  Layer.provide(TestTelemetryLive),
  Layer.provide(TestVsCode.Default),
);

describe("Uv", () => {
  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
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
    it.scoped(
      "should fail `uv add` without pyproject.toml",
      Effect.fn(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;
        const result = yield* Effect.either(
          uv.addProject({ directory: tmpdir.path, packages: ["httpx"] }),
        );
        assert(Either.isLeft(result), "Expected failure");
        assert.strictEqual(result.left._tag, "UvMissingPyProjectError");
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
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
    it.scoped(
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
    it.scoped(
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
    it.scoped(
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
    it.scoped(
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
        const result = yield* Effect.either(uv.syncScript({ script }));

        assert(Either.isLeft(result), "Expected failure");
        assert.strictEqual(result.left._tag, "UvResolutionError");
      }),
      { timeout },
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
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
        const result = yield* Effect.either(uv.currentDeps({ script }));

        assert(Either.isLeft(result), "Expected failure");
        assert.strictEqual(result.left._tag, "UvMissingPep723MetadataError");
      }),
      { timeout },
    );
  });

  it("should resolve relative script environment paths", () => {
    const envPath = resolveScriptEnvironmentPath(
      "Using script environment at: .cache/uv/environments-v2/test",
    );

    expect(envPath).toBe(NodePath.resolve(".cache/uv/environments-v2/test"));
  });

  describe("ensureLanguageServerBinaryInstalled", () => {
    const server = { name: "ruff", version: "0.11.4" } as const;

    const singleStrategy = <T extends string>(initial: T) => ({
      initial,
      next: () => Option.none(),
    });

    it.layer(Layer.fresh(UvLive))((it) => {
      it.scoped(
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

      it.scoped(
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

      it.scoped(
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
      it.scoped.skipIf(isWindows)(
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

      it.scoped.skipIf(!isWindows)(
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

      it.scoped(
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
