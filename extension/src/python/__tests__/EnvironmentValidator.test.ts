import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { assert, describe, expect, it } from "@effect/vitest";
import { Effect, Either, Layer, Schema } from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { EnvironmentValidator } from "../../python/EnvironmentValidator.ts";
import { getVenvPythonPath } from "../../python/getVenvPythonPath.ts";
import { PythonEnvInvalidation } from "../../python/PythonEnvInvalidation.ts";
import { Uv } from "../../python/Uv.ts";
import { SemVerFromString } from "../../schemas/SemVerFromString.ts";

const isWindows = NodeProcess.platform === "win32";

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
  Layer.provideMerge(PythonEnvInvalidation.Default),
  Layer.provide(TestPythonExtension.Default),
  Layer.provide(TestTelemetryLive),
  Layer.provide(TestVsCode.Default),
);

it.layer(EnvironmentValidatorLive)("EnvironmentValidator", (it) => {
  const python = "3.13";

  it.effect(
    "should build",
    Effect.fn(function* () {
      const api = yield* EnvironmentValidator;
      expect(api).toBeDefined();
    }),
  );

  it.effect(
    "should fail with missing marimo",
    Effect.fn(function* () {
      const uv = yield* Uv;
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      // Validation results are cached per interpreter path, so each test
      // uses its own venv directory.
      const venv = NodePath.join(tmpdir.path, ".venv-missing");
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
        ]
      `);
    }),
  );

  // Skipped on Windows: pygls intermittently hits OSError [Errno 22] on
  // stdout flush while shutting down the server subprocess, which causes
  // the test to hang past the 30s timeout. The non-Windows runs cover this.
  it.effect.skipIf(isWindows)(
    "Should fail with outdated marimo",
    Effect.fn(function* () {
      const uv = yield* Uv;
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv-outdated");
      yield* uv.venv(venv, { python, clear: true });
      yield* uv.pipInstall(["marimo<0.16.0"], { venv });

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
      	      "minor": 23,
      	      "patch": 3,
      	    },
      	  },
      	]
      `);
    }),
    { timeout: 30_000 },
  );

  it.effect(
    "should succeed with marimo installed",
    Effect.fn(function* () {
      const uv = yield* Uv;
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv-ok");
      yield* uv.venv(venv, { python, clear: true });
      yield* uv.pipInstall(["marimo"], { venv });

      const result = yield* Effect.either(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );

      assert(Either.isRight(result), "Expected validation to succeed");
      assert.strictEqual(result.right._tag, "ValidPythonEnvironment");
    }),
    { timeout: 60_000 },
  );

  it.effect(
    "should fail for no python interpreter",
    Effect.fn(function* () {
      const validator = yield* EnvironmentValidator;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv-nonexistent");
      NodeFs.rmSync(venv, { recursive: true, force: true });

      const result = yield* Effect.either(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );
      assert(Either.isLeft(result), "Expected validation to fail");
      assert.strictEqual(result.left._tag, "EnvironmentInspectionError");
    }),
    { timeout: 30_000 },
  );

  // These tests use bash scripts as fake executables.
  // On Windows, child_process.spawn can only execute PE (.exe) files
  // directly, so we skip these tests there.
  describe.skipIf(isWindows)("subprocess output parsing", () => {
    it.effect(
      "should fail with EnvironmentInspectionError when stdout is empty",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "empty-stdout", {
          stdout: "",
          exitCode: 0,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isLeft(result), "Expected validation to fail");
        assert.strictEqual(result.left._tag, "EnvironmentInspectionError");
      }),
    );

    it.effect(
      "should fail with EnvironmentInspectionError when stdout is not JSON",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "non-json", {
          stdout: "WARNING: some import warning\nAnother warning line\n",
          exitCode: 0,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isLeft(result), "Expected validation to fail");
        assert(
          result.left._tag === "EnvironmentInspectionError",
          `Expected EnvironmentInspectionError, got ${result.left._tag}`,
        );
        expect(result.left.stdout).toContain("WARNING");
      }),
    );

    it.effect(
      "should fail with EnvironmentInspectionError on non-zero exit code",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "exit-1", {
          stdout: "",
          stderr: "Traceback: SyntaxError in sitecustomize.py",
          exitCode: 1,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isLeft(result), "Expected validation to fail");
        assert(
          result.left._tag === "EnvironmentInspectionError",
          `Expected EnvironmentInspectionError, got ${result.left._tag}`,
        );
        expect(result.left.stderr).toContain("SyntaxError");
      }),
    );

    it.effect(
      "should fail with EnvironmentInspectionError on truncated JSON",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "truncated-json", {
          stdout: '[{"name":"marimo","version"',
          exitCode: 0,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isLeft(result), "Expected validation to fail");
        assert.strictEqual(result.left._tag, "EnvironmentInspectionError");
      }),
    );

    it.effect(
      "should fail with EnvironmentInspectionError on wrong JSON shape",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "wrong-shape", {
          stdout: '{"error": "unexpected format"}',
          exitCode: 0,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isLeft(result), "Expected validation to fail");
        assert.strictEqual(result.left._tag, "EnvironmentInspectionError");
      }),
    );

    it.effect(
      "should handle JSON with extra whitespace/newlines",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const json = JSON.stringify([{ name: "marimo", version: "1.0.0" }]);
        const script = makeFakeExecutable(tmpdir.path, "extra-whitespace", {
          stdout: `\n  ${json}  \n`,
          exitCode: 0,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isRight(result), "Expected validation to succeed");
        assert.strictEqual(result.right._tag, "ValidPythonEnvironment");
      }),
    );

    it.effect(
      "should treat null versions as missing packages",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const json = JSON.stringify([{ name: "marimo", version: null }]);
        const script = makeFakeExecutable(tmpdir.path, "null-versions", {
          stdout: json,
          exitCode: 0,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isLeft(result), "Expected validation to fail");
        assert(
          result.left._tag === "EnvironmentRequirementError",
          `Expected EnvironmentRequirementError, got ${result.left._tag}`,
        );
        expect(result.left.diagnostics).toEqual([
          { kind: "missing", package: "marimo" },
        ]);
      }),
    );

    it.effect(
      "should cache successful validation per environment",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const countFile = NodePath.join(tmpdir.path, "cached-success-count");
        const json = JSON.stringify([{ name: "marimo", version: "1.0.0" }]);
        const script = makeFakeExecutable(tmpdir.path, "cached-success", {
          stdout: json,
          exitCode: 0,
          countFile,
        });
        const env = TestPythonExtension.makeGlobalEnv(script);

        const first = yield* validator.validate(env);
        const second = yield* validator.validate(env);

        assert.strictEqual(first._tag, "ValidPythonEnvironment");
        assert.strictEqual(second._tag, "ValidPythonEnvironment");
        expect(runCount(countFile)).toBe(1);
      }),
    );

    it.effect(
      "should not cache failed validation",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const countFile = NodePath.join(tmpdir.path, "uncached-failure-count");
        const json = JSON.stringify([{ name: "marimo", version: null }]);
        const script = makeFakeExecutable(tmpdir.path, "uncached-failure", {
          stdout: json,
          exitCode: 0,
          countFile,
        });
        const env = TestPythonExtension.makeGlobalEnv(script);

        const first = yield* Effect.either(validator.validate(env));
        const second = yield* Effect.either(validator.validate(env));

        assert(Either.isLeft(first), "Expected first validation to fail");
        assert(Either.isLeft(second), "Expected second validation to fail");
        expect(runCount(countFile)).toBe(2);
      }),
    );

    it.effect(
      "should re-validate after a PythonEnvInvalidation event",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const invalidation = yield* PythonEnvInvalidation;
        const tmpdir = yield* TempDir;
        const countFile = NodePath.join(tmpdir.path, "invalidation-count");
        const json = JSON.stringify([{ name: "marimo", version: "1.0.0" }]);
        const script = makeFakeExecutable(tmpdir.path, "invalidation", {
          stdout: json,
          exitCode: 0,
          countFile,
        });
        const env = TestPythonExtension.makeGlobalEnv(script);

        yield* validator.validate(env);
        expect(runCount(countFile)).toBe(1);

        yield* invalidation.invalidate("package-install");

        // The cache clears in a background fiber; yield and re-validate
        // until the subprocess is spawned again.
        let count = runCount(countFile);
        for (let i = 0; i < 100 && count < 2; i++) {
          yield* Effect.yieldNow();
          yield* validator.validate(env);
          count = runCount(countFile);
        }
        expect(count).toBe(2);
      }),
    );

    it.effect(
      "should fail with EnvironmentInspectionError when stderr has content but exit code 0 and empty stdout",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "stderr-only", {
          stdout: "",
          stderr: "Fatal Python error: init_fs_encoding",
          exitCode: 0,
        });

        const result = yield* Effect.either(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        assert(Either.isLeft(result), "Expected validation to fail");
        assert.strictEqual(result.left._tag, "EnvironmentInspectionError");
      }),
    );
  });
});

/** Create an executable bash script that outputs specific stdout/stderr. */
function makeFakeExecutable(
  dir: string,
  name: string,
  opts: {
    stdout: string;
    stderr?: string;
    exitCode: number;
    /** File the script appends a line to on every invocation. */
    countFile?: string;
  },
): string {
  const scriptPath = NodePath.join(dir, name);
  const lines = ["#!/bin/bash"];
  if (opts.countFile) {
    lines.push(`echo run >> ${shellEscape(opts.countFile)}`);
  }
  if (opts.stdout) {
    lines.push(`printf '%s' ${shellEscape(opts.stdout)}`);
  }
  if (opts.stderr) {
    lines.push(`printf '%s' ${shellEscape(opts.stderr)} >&2`);
  }
  lines.push(`exit ${opts.exitCode}`);
  NodeFs.writeFileSync(scriptPath, lines.join("\n"), { mode: 0o755 });
  return scriptPath;
}

/** Number of times a `countFile`-instrumented fake executable ran. */
function runCount(countFile: string): number {
  try {
    return NodeFs.readFileSync(countFile, "utf8").split("\n").filter(Boolean)
      .length;
  } catch {
    return 0;
  }
}

function shellEscape(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

// -- SemVerFromString schema edge cases --

const decodeSemVer = Schema.decodeUnknownEither(SemVerFromString);

it.effect(
  "SemVerFromString: parses standard semver",
  Effect.fn(function* () {
    yield* Effect.void;
    const result = decodeSemVer("1.2.3");
    assert(Either.isRight(result));
    expect(result.right).toEqual({ major: 1, minor: 2, patch: 3 });
  }),
);

it.effect(
  "SemVerFromString: parses two-part version (PyPI style)",
  Effect.fn(function* () {
    yield* Effect.void;
    const result = decodeSemVer("26.2");
    assert(Either.isRight(result));
    expect(result.right).toEqual({ major: 26, minor: 2, patch: 0 });
  }),
);

it.effect(
  "SemVerFromString: parses version with prerelease suffix",
  Effect.fn(function* () {
    yield* Effect.void;
    const result = decodeSemVer("0.21.0-rc1");
    assert(Either.isRight(result));
    expect(result.right).toEqual({ major: 0, minor: 21, patch: 0 });
  }),
);

it.effect(
  "SemVerFromString: fails on garbage input",
  Effect.fn(function* () {
    yield* Effect.void;
    const result = decodeSemVer("not-a-version");
    assert(Either.isLeft(result));
  }),
);

it.effect(
  "SemVerFromString: fails on empty string",
  Effect.fn(function* () {
    yield* Effect.void;
    const result = decodeSemVer("");
    assert(Either.isLeft(result));
  }),
);
