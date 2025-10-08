import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Either } from "effect";
import { Uv } from "../../services/Uv.ts";

function test(
  name: string,
  fn: (ctx: {
    tmpdir: string;
    python: string;
  }) => Effect.Effect<void, void, Uv>,
) {
  const python = "3.13";
  it.scoped(
    name,
    Effect.fnUntraced(function* () {
      const disposable = yield* Effect.acquireRelease(
        Effect.sync(() => {
          return NodeFs.mkdtempDisposableSync(
            NodePath.join(NodeOs.tmpdir(), "marimo-lsp-"),
          );
        }),
        (disposable) => Effect.sync(() => disposable.remove()),
      );
      return yield* Effect.provide(
        fn({ tmpdir: disposable.path, python }),
        Uv.Default,
      );
    }),
  );
}

describe("Uv", () => {
  test(
    "should create a new python venv",
    Effect.fnUntraced(function* (ctx) {
      const uv = yield* Uv;
      const target = NodePath.join(ctx.tmpdir, ".venv");
      yield* uv.venv(target, { python: ctx.python });
      assert(NodeFs.existsSync(target), "Expected new venv.");
    }),
  );

  test(
    "should fail `uv add` without pyproject.toml",
    Effect.fnUntraced(function* (ctx) {
      const uv = yield* Uv;
      const result = yield* Effect.either(
        uv.add(["httpx"], { directory: ctx.tmpdir }),
      );
      assert(Either.isLeft(result), "Expected failure");
      assert.strictEqual(result.left._tag, "MissingPyProjectError");
    }),
  );

  test(
    "should `uv pip install` into venv",
    Effect.fnUntraced(function* (ctx) {
      const uv = yield* Uv;

      const venv = NodePath.join(ctx.tmpdir, ".venv");
      yield* uv.venv(venv, { python: ctx.python });

      yield* uv.pipInstall(["httpx"], { venv });
      const sitePackages = NodePath.join(
        venv,
        "lib",
        `python${ctx.python}`,
        "site-packages",
      );
      assert(
        NodeFs.existsSync(NodePath.join(sitePackages, "httpx")),
        `Expected httpx to be in ${sitePackages}`,
      );
    }),
  );

  test(
    "should `uv init` a new project",
    Effect.fnUntraced(function* (ctx) {
      const uv = yield* Uv;

      const target = NodePath.join(ctx.tmpdir, "foo");
      yield* uv.init(target, { python: ctx.python });

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
