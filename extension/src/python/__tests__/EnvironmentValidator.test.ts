import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer, Result } from "effect";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import * as TestTelemetry from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as EnvironmentValidator from "../../python/EnvironmentValidator.ts";
import { getVenvPythonPath } from "../../python/getVenvPythonPath.ts";
import * as PythonEnvInvalidation from "../../python/PythonEnvInvalidation.ts";
import * as Uv from "../../python/Uv.ts";

const isWindows = NodeProcess.platform === "win32";

class TempDir extends Context.Service<TempDir>()("TempDir", {
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

const layer = Layer.empty.pipe(
  Layer.provideMerge(TempDir.layer),
  Layer.provideMerge(Uv.layer),
  Layer.provideMerge(EnvironmentValidator.layer),
  Layer.provideMerge(PythonEnvInvalidation.layer),
  Layer.provide(TestPythonExtension.layer),
  Layer.provide(TestTelemetry.TestTelemetryLive),
  Layer.provide(TestVsCode.layer),
);

Vitest.describe("EnvironmentValidator", () => {
  const it = EffectTest.make(layer);
  const python = "3.13";

  it.live(
    "should build",
    Effect.fn(function* () {
      const api = yield* EnvironmentValidator.Service;
      Vitest.expect(api).toBeDefined();
    }),
  );

  it.live(
    "should fail with missing marimo",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const validator = yield* EnvironmentValidator.Service;
      const tmpdir = yield* TempDir;

      // Validation results are cached per interpreter path, so each test
      // uses its own venv directory.
      const venv = NodePath.join(tmpdir.path, ".venv-missing");
      yield* uv.venv(venv, { python, clear: true });

      const result = yield* Effect.result(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );

      Vitest.assert(Result.isFailure(result), "Expected validation to fail");
      Vitest.assert(
        result.failure._tag === "EnvironmentValidator.RequirementError",
        `Expected RequirementError, got ${result.failure._tag}`,
      );
      Vitest.expect(result.failure.diagnostics).toMatchInlineSnapshot(`
        [
          {
            "kind": "missing",
            "package": "marimo",
          },
        ]
      `);
    }),
    { timeout: 30_000 },
  );

  // Skipped on Windows: pygls intermittently hits OSError [Errno 22] on
  // stdout flush while shutting down the server subprocess, which causes
  // the test to hang past the 30s timeout. The non-Windows runs cover this.
  it.live.skipIf(isWindows)(
    "Should fail with outdated marimo",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const validator = yield* EnvironmentValidator.Service;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv-outdated");
      yield* uv.venv(venv, { python, clear: true });
      yield* uv.pipInstall(["marimo<0.16.0"], { venv });

      const result = yield* Effect.result(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );

      Vitest.assert(Result.isFailure(result), "Expected validation to fail");
      Vitest.assert(
        result.failure._tag === "EnvironmentValidator.RequirementError",
        `Expected RequirementError, got ${result.failure._tag}`,
      );
      Vitest.expect(result.failure.diagnostics).toMatchInlineSnapshot(`
        [
          {
            "currentVersion": Version {
              "value": "0.15.5",
            },
            "kind": "outdated",
            "package": "marimo",
            "requiredVersion": Version {
              "value": "0.23.3",
            },
          },
        ]
      `);
    }),
    { timeout: 30_000 },
  );

  it.live(
    "should succeed with marimo installed",
    Effect.fn(function* () {
      const uv = yield* Uv.Service;
      const validator = yield* EnvironmentValidator.Service;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv-ok");
      yield* uv.venv(venv, { python, clear: true });
      yield* uv.pipInstall(["marimo"], { venv });

      const result = yield* Effect.result(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );

      Vitest.assert(Result.isSuccess(result), "Expected validation to succeed");
      Vitest.assert.strictEqual(result.success._tag, "ValidPythonEnvironment");
    }),
    { timeout: 60_000 },
  );

  it.live(
    "should fail for no python interpreter",
    Effect.fn(function* () {
      const validator = yield* EnvironmentValidator.Service;
      const tmpdir = yield* TempDir;

      const venv = NodePath.join(tmpdir.path, ".venv-nonexistent");
      NodeFs.rmSync(venv, { recursive: true, force: true });

      const result = yield* Effect.result(
        validator.validate(
          TestPythonExtension.makeVenv(getVenvPythonPath(venv)),
        ),
      );
      Vitest.assert(Result.isFailure(result), "Expected validation to fail");
      Vitest.assert.strictEqual(
        result.failure._tag,
        "EnvironmentValidator.InspectionError",
      );
    }),
    { timeout: 30_000 },
  );

  // These tests use bash scripts as fake executables.
  // On Windows, child_process.spawn can only execute PE (.exe) files
  // directly, so we skip these tests there.
  Vitest.describe.skipIf(isWindows)("subprocess output parsing", () => {
    it.live(
      "should fail with InspectionError when stdout is empty",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "empty-stdout", {
          stdout: "",
          exitCode: 0,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(Result.isFailure(result), "Expected validation to fail");
        Vitest.assert.strictEqual(
          result.failure._tag,
          "EnvironmentValidator.InspectionError",
        );
      }),
    );

    it.live(
      "should fail with InspectionError when stdout is not JSON",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "non-json", {
          stdout: "WARNING: some import warning\nAnother warning line\n",
          exitCode: 0,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(Result.isFailure(result), "Expected validation to fail");
        Vitest.assert(
          result.failure._tag === "EnvironmentValidator.InspectionError",
          `Expected InspectionError, got ${result.failure._tag}`,
        );
        Vitest.expect(result.failure.stdout).toContain("WARNING");
      }),
    );

    it.live(
      "should fail with InspectionError on non-zero exit code",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "exit-1", {
          stdout: "",
          stderr: "Traceback: SyntaxError in sitecustomize.py",
          exitCode: 1,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(Result.isFailure(result), "Expected validation to fail");
        Vitest.assert(
          result.failure._tag === "EnvironmentValidator.InspectionError",
          `Expected InspectionError, got ${result.failure._tag}`,
        );
        Vitest.expect(result.failure.stderr).toContain("SyntaxError");
      }),
    );

    it.live(
      "should fail with InspectionError on truncated JSON",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "truncated-json", {
          stdout: '[{"name":"marimo","version"',
          exitCode: 0,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(Result.isFailure(result), "Expected validation to fail");
        Vitest.assert.strictEqual(
          result.failure._tag,
          "EnvironmentValidator.InspectionError",
        );
      }),
    );

    it.live(
      "should fail with InspectionError on wrong JSON shape",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "wrong-shape", {
          stdout: '{"error": "unexpected format"}',
          exitCode: 0,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(Result.isFailure(result), "Expected validation to fail");
        Vitest.assert.strictEqual(
          result.failure._tag,
          "EnvironmentValidator.InspectionError",
        );
      }),
    );

    it.live(
      "should handle JSON with extra whitespace/newlines",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const json = JSON.stringify([{ name: "marimo", version: "1.0.0" }]);
        const script = makeFakeExecutable(tmpdir.path, "extra-whitespace", {
          stdout: `\n  ${json}  \n`,
          exitCode: 0,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(
          Result.isSuccess(result),
          "Expected validation to succeed",
        );
        Vitest.assert.strictEqual(
          result.success._tag,
          "ValidPythonEnvironment",
        );
      }),
    );

    it.live(
      "should treat null versions as missing packages",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const json = JSON.stringify([{ name: "marimo", version: null }]);
        const script = makeFakeExecutable(tmpdir.path, "null-versions", {
          stdout: json,
          exitCode: 0,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(Result.isFailure(result), "Expected validation to fail");
        Vitest.assert(
          result.failure._tag === "EnvironmentValidator.RequirementError",
          `Expected RequirementError, got ${result.failure._tag}`,
        );
        Vitest.expect(result.failure.diagnostics).toEqual([
          { kind: "missing", package: "marimo" },
        ]);
      }),
    );

    it.live(
      "should cache successful validation per environment",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
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

        Vitest.assert.strictEqual(first._tag, "ValidPythonEnvironment");
        Vitest.assert.strictEqual(second._tag, "ValidPythonEnvironment");
        Vitest.expect(runCount(countFile)).toBe(1);
      }),
    );

    it.live(
      "should not cache failed validation",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const countFile = NodePath.join(tmpdir.path, "uncached-failure-count");
        const json = JSON.stringify([{ name: "marimo", version: null }]);
        const script = makeFakeExecutable(tmpdir.path, "uncached-failure", {
          stdout: json,
          exitCode: 0,
          countFile,
        });
        const env = TestPythonExtension.makeGlobalEnv(script);

        const first = yield* Effect.result(validator.validate(env));
        const second = yield* Effect.result(validator.validate(env));

        Vitest.assert(
          Result.isFailure(first),
          "Expected first validation to fail",
        );
        Vitest.assert(
          Result.isFailure(second),
          "Expected second validation to fail",
        );
        Vitest.expect(runCount(countFile)).toBe(2);
      }),
    );

    it.live(
      "should re-validate after a PythonEnvInvalidation event",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const invalidation = yield* PythonEnvInvalidation.Service;
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
        Vitest.expect(runCount(countFile)).toBe(1);

        yield* invalidation.invalidate("package-install");
        yield* validator.validate(env);
        Vitest.expect(runCount(countFile)).toBe(2);
      }),
    );

    it.live(
      "should fail with InspectionError when stderr has content but exit code 0 and empty stdout",
      Effect.fn(function* () {
        const validator = yield* EnvironmentValidator.Service;
        const tmpdir = yield* TempDir;
        const script = makeFakeExecutable(tmpdir.path, "stderr-only", {
          stdout: "",
          stderr: "Fatal Python error: init_fs_encoding",
          exitCode: 0,
        });

        const result = yield* Effect.result(
          validator.validate(TestPythonExtension.makeGlobalEnv(script)),
        );

        Vitest.assert(Result.isFailure(result), "Expected validation to fail");
        Vitest.assert.strictEqual(
          result.failure._tag,
          "EnvironmentValidator.InspectionError",
        );
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
