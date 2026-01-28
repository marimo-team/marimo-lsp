import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Uv } from "../../services/Uv.ts";

const python = "3.13";

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
  Layer.provide(TestSentryLive),
  Layer.provide(TestTelemetryLive),
  Layer.provide(TestVsCode.Default),
);

describe("Uv", () => {
  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should create a new python venv",
      Effect.fnUntraced(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;
        const target = NodePath.join(tmpdir.path, ".venv");
        yield* uv.venv(target, { python });
        assert(NodeFs.existsSync(target), "Expected new venv.");
      }),
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should fail `uv add` without pyproject.toml",
      Effect.fnUntraced(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;
        const result = yield* Effect.either(
          uv.addProject({ directory: tmpdir.path, packages: ["httpx"] }),
        );
        assert(Either.isLeft(result), "Expected failure");
        assert.strictEqual(result.left._tag, "UvMissingPyProjectError");
      }),
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should `uv pip install` into venv",
      Effect.fnUntraced(function* () {
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
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should `uv init` a new project",
      Effect.fnUntraced(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;

        const target = NodePath.join(tmpdir.path, "foo");
        yield* uv.init(target, { python });

        const pyproject = NodePath.join(target, "pyproject.toml");
        assert(NodeFs.existsSync(pyproject), `Expected to create ${pyproject}`);
        expect(
          NodeFs.readFileSync(pyproject, { encoding: "utf8" }),
        ).toMatchInlineSnapshot(`
        "[project]
        name = "foo"
        version = "0.1.0"
        description = "Add your description here"
        readme = "README.md"
        requires-python = ">=3.13"
        dependencies = []
        "
      `);
      }),
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should fail with UvResolutionError on conflicting dependencies",
      Effect.fnUntraced(function* () {
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
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should fail with UvMissingPep723MetadataError when script has no metadata",
      Effect.fnUntraced(function* () {
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
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should return absolute path from syncScript even if uv outputs relative path",
      Effect.fnUntraced(function* () {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;

        const script = NodePath.join(tmpdir.path, "test-script.py");
        NodeFs.writeFileSync(
          script,
          `\
# /// script
# requires-python = ">=3.13"
# dependencies = []
# ///

print("hello")
`,
          { encoding: "utf8" },
        );

        // Change CWD to home directory to trigger uv's relative path output.
        // uv uses user_display() which strips CWD prefix from paths.
        // When CWD is home (~), cache path ~/.cache/uv/... becomes .cache/uv/...
        const originalCwd = NodeProcess.cwd();
        NodeProcess.chdir(NodeOs.homedir());
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeProcess.chdir(originalCwd))
        );

        const envPath = yield* uv.syncScript({ script });

        assert(
          NodePath.isAbsolute(envPath),
          `Expected absolute path, got: ${envPath}`,
        );

        assert(
          NodeFs.existsSync(envPath),
          `Expected environment path to exist: ${envPath}`,
        );
      }),
    );
  });
});
