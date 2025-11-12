import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Uv } from "../../services/Uv.ts";

const python = "3.13";

class TmpDir extends Effect.Service<TmpDir>()("TmpDir", {
  scoped: Effect.gen(function*() {
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
}) { }

const UvLive = Layer.empty.pipe(
  Layer.merge(Uv.Default),
  Layer.merge(TmpDir.Default),
  Layer.provide(TestVsCode.Default),
);

describe("Uv", () => {
  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should create a new python venv",
      Effect.fnUntraced(function*() {
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
      Effect.fnUntraced(function*() {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;
        const result = yield* Effect.either(
          uv.addProject({ directory: tmpdir.path, packages: ["httpx"] }),
        );
        assert(Either.isLeft(result), "Expected failure");
        assert.strictEqual(result.left._tag, "MissingPyProjectError");
      }),
    );
  });

  it.layer(Layer.fresh(UvLive))((it) => {
    it.scoped(
      "should `uv pip install` into venv",
      Effect.fnUntraced(function*() {
        const uv = yield* Uv;
        const tmpdir = yield* TmpDir;
        const venv = NodePath.join(tmpdir.path, ".venv");
        yield* uv.venv(venv, { python });

        yield* uv.pipInstall(["httpx"], { venv });
        const sitePackages = NodePath.join(
          venv,
          "lib",
          `python${python}`,
          "site-packages",
        );
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
      Effect.fnUntraced(function*() {
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
});
