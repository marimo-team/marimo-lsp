import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, expect, it } from "@effect/vitest";
import type * as py from "@vscode/python-extension";
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
  const env = (path: string) =>
    ({
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
    }) satisfies py.Environment;

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
      yield* uv.venv(venv, { python, clear: true });

      const result = yield* Effect.either(
        validator.validate(env(NodePath.join(venv, "bin", "python"))),
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
      yield* uv.venv(venv, { python, clear: true });
      yield* uv.pipInstall(["marimo"], { venv });

      const result = yield* Effect.either(
        validator.validate(env(NodePath.join(venv, "bin", "python"))),
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
    "Should fail with outdated marimo",
    Effect.fnUntraced(function* () {
      const uv = yield* Uv;
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv");
      yield* uv.venv(venv, { python, clear: true });
      yield* uv.pipInstall(["marimo<0.16.0", "pyzmq"], { venv });

      const result = yield* Effect.either(
        validator.validate(env(NodePath.join(venv, "bin", "python"))),
      );

      assert(Either.isLeft(result), "Expected validation to fail");
      assert(
        result.left._tag === "EnvironmentRequirementError",
        `Expected EnvironmentRequirementError, got ${result.left._tag}`,
      );
      expect(result.left.diagnostics).toMatchInlineSnapshot(`
        [
          {
            "currentVersion": {
              "major": 0,
              "minor": 15,
              "patch": 5,
            },
            "kind": "outdated",
            "package": "marimo",
            "requiredVersion": {
              "major": 0,
              "minor": 16,
              "patch": 0,
            },
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
      yield* uv.venv(venv, { python, clear: true });
      yield* uv.pipInstall(["marimo", "pyzmq"], { venv });

      const result = yield* Effect.either(
        validator.validate(env(NodePath.join(venv, "bin", "python"))),
      );

      assert(Either.isRight(result), "Expected validation to succeed");
      expect(result.right._tag).toBe("ValidPythonEnvironment");
    }),
  );

  it.effect(
    "should fail for no python interpreter",
    Effect.fnUntraced(function* () {
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv");
      NodeFs.rmSync(venv, { recursive: true });

      const result = yield* Effect.either(
        validator.validate(env(NodePath.join(venv, "bin", "python"))),
      );
      assert(Either.isLeft(result), "Expected validation to fail");
      assert(
        result.left._tag === "EnvironmentInspectionError",
        `Expected EnvironmentInspectionError, got ${result.left._tag}`,
      );
    }),
  );
});
