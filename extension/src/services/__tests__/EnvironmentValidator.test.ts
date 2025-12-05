import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import { assert, expect, it } from "@effect/vitest";
import { Effect, Either, Layer } from "effect";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { getVenvPythonPath } from "../../utils/getVenvPythonPath.ts";
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
  Layer.provide(TestVsCode.Default),
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
      yield* uv.venv(venv, { python, clear: true });

      const result = yield* Effect.either(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
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
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
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
    { timeout: 30_000 },
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
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
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
              "minor": 17,
              "patch": 0,
            },
          },
        ]
      `);
    }),
    { timeout: 30_000 },
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
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );

      assert(Either.isRight(result), "Expected validation to succeed");
      assert.strictEqual(result.right._tag, "ValidPythonEnvironment");
    }),
    { timeout: 30_000 },
  );

  it.effect(
    "should fail for no python interpreter",
    Effect.fnUntraced(function* () {
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv");
      NodeFs.rmSync(venv, { recursive: true });

      const result = yield* Effect.either(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );
      assert(Either.isLeft(result), "Expected validation to fail");
      assert.strictEqual(result.left._tag, "EnvironmentInspectionError");
    }),
  );
});
