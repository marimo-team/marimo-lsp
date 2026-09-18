import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Result } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { resolveScriptEnvironmentPath, Uv } from "../../python/Uv.ts";
import { ProjectDependencyTarget } from "../ProjectDependencyTarget.ts";

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

const UvLive = Layer.empty.pipe(
  Layer.merge(Uv.layer),
  Layer.merge(TmpDir.layer),
  Layer.provide(TestTelemetryLive),
  Layer.provide(TestVsCode.layer),
);

describe("Uv", () => {
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

  it("should resolve relative script environment paths", () => {
    const envPath = resolveScriptEnvironmentPath(
      "Using script environment at: .cache/uv/environments-v2/test",
    );

    expect(envPath).toBe(NodePath.resolve(".cache/uv/environments-v2/test"));
  });
});
