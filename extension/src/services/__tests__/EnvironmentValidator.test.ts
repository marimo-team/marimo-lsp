import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, expect, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { EnvironmentValidator } from "../EnvironmentValidator.ts";
import { Uv } from "../Uv.ts";

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

const EnvironmentValidatorLive = Layer.empty.pipe(
  Layer.provideMerge(TempDir.Default),
  Layer.provideMerge(Uv.Default),
  Layer.provideMerge(EnvironmentValidator.Default),
);

it.layer(EnvironmentValidatorLive)("EnvironmentValidator", (it) => {
  const python = "3.13";

  it.effect(
    "should build",
    Effect.fnUntraced(function* () {
      const api = yield* EnvironmentValidator;
      expect(api).toBeDefined();
    }),
  );

  it.effect(
    "should fail with missing marimo",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv");
      yield* uv.venv(venv, { python });

      const result = yield* Effect.either(
        validator.validate({
          path: NodePath.join(venv, "bin", "python"),
        }),
      );

      assert(Either.isLeft(result), "Expected validation to fail");
      assert(
        result.left._tag === "EnvironmentRequirementError",
        `Expected EnvironmentRequirementError, got ${result.left._tag}`,
      );
      expect(result.left.diagnostics).toMatchInlineSnapshot(`
        [
          {
            "kind": "missing",
            "package": "marimo",
          },
          {
            "kind": "missing",
            "package": "pyzmq",
          },
        ]
      `);
    }),
  );

  it.effect(
    "should fail with missing pyzmq",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv");
      yield* uv.venv(venv, { python });
      yield* uv.pipInstall(["marimo"], { venv });

      const result = yield* Effect.either(
        validator.validate({ path: NodePath.join(venv, "bin", "python") }),
      );

      assert(Either.isLeft(result), "Expected validation to fail");
      assert(
        result.left._tag === "EnvironmentRequirementError",
        `Expected EnvironmentRequirementError, got ${result.left._tag}`,
      );
      expect(result.left.diagnostics).toMatchInlineSnapshot(`
        [
          {
            "kind": "missing",
            "package": "pyzmq",
          },
        ]
      `);
    }),
  );

  it.effect(
    "should succeed with marimo and pyzmq installed",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv");
      yield* uv.venv(venv, { python });
      yield* uv.pipInstall(["marimo", "pyzmq"], { venv });

      const path = NodePath.join(venv, "bin", "python");
      const result = yield* Effect.either(
        validator.validate({
          id: path,
          path: path,
          environment: undefined,
          tools: [],
          version: undefined,
          executable: {
            uri: undefined,
            bitness: undefined,
            sysPrefix: undefined,
          },
        }),
      );

      assert(Either.isRight(result), "Expected validation to succeed");
      expect(result.right._tag).toBe("ValidPythonEnvironment");
    }),
  );
});
