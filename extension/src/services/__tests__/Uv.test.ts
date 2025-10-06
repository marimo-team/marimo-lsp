import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, expect, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { Uv } from "../../services/Uv.ts";

class TempDir extends Effect.Service<TempDir>()("TempDir", {
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
  Layer.provideMerge(TempDir.Default),
  Layer.provideMerge(Uv.Default),
);

it.layer(UvLive)("Uv", (it) => {
  const python = "3.13";

  it.effect(
    "should create a new python venv",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const tmpdir = yield* TempDir;
      const target = NodePath.join(tmpdir.path, ".venv");
      yield* uv.venv(target, { python });
      assert(NodeFs.existsSync(target), "Expected new venv.");
    }),
  );

  it.effect(
    "should fail `uv add` without pyproject.toml",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const tmpdir = yield* TempDir;
      const result = yield* Effect.either(
        uv.add(["httpx"], { directory: tmpdir.path }),
      );
      assert(Either.isLeft(result), "Expected failure");
      assert.strictEqual(result.left._tag, "MissingPyProjectError");
    }),
  );

  it.effect(
    "should `uv pip install` into venv",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv");
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

  it.effect(
    "should `uv init` a new project",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const tmpdir = yield* TempDir;

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
