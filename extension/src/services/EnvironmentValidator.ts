import * as NodeChildProcess from "node:child_process";
import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Data, Effect, Schema } from "effect";
import { SemVerFromString } from "../schemas.ts";

const MINIMUM_MARIMO_VERSION = {
  major: 0,
  minor: 16,
  patch: 0,
} satisfies semver.SemVer;

class PythonExecutionError extends Data.TaggedError("PythonExecutionError")<{
  readonly env: py.Environment;
  readonly error: NodeChildProcess.ExecFileException;
  readonly stderr: string;
}> {}

class EnvironmentRequirementError extends Data.TaggedError(
  "EnvironmentRequirementError",
)<{
  readonly env: py.Environment;
  readonly diagnostics: ReadonlyArray<RequirementDiagnostic>;
}> {}

/**
 * Validates Python environments for marimo extension compatibility.
 *
 * Checks for:
 *
 *   - marimo (with version requirement)
 *   - pyzmq
 *
 * using `env.executable`.
 */
export class EnvironmentValidator extends Effect.Service<EnvironmentValidator>()(
  "EnvironmentValidator",
  {
    succeed: {
      validate(
        env: py.Environment,
      ): Effect.Effect<
        ValidPythonEnvironemnt,
        PythonExecutionError | EnvironmentRequirementError,
        never
      > {
        const EnvCheck = Schema.Array(
          Schema.Struct({
            name: Schema.String,
            version: Schema.NullOr(SemVerFromString),
          }),
        );
        return Effect.gen(function* () {
          const stdout = yield* Effect.async<string, PythonExecutionError>(
            (resume) => {
              NodeChildProcess.execFile(
                env.path,
                [
                  "-c",
                  `\
import json

packages = []

try:
    import marimo
    packages.append({"name":"marimo","version":marimo.__version__})
except ImportError:
    packages.append({"name":"marimo","version":None})
    pass

try:
    import zmq
    packages.append({"name":"pyzmq","version":zmq.__version__})
except ImportError:
    packages.append({"name":"pyzmq","version":None})
    pass

print(json.dumps(packages))`,
                ],
                (error, stdout, stderr) => {
                  if (!error) {
                    resume(Effect.succeed(stdout));
                  } else {
                    resume(
                      Effect.fail(
                        new PythonExecutionError({ env, error, stderr }),
                      ),
                    );
                  }
                },
              );
            },
          );

          const packages = yield* Schema.decode(Schema.parseJson(EnvCheck))(
            stdout.trim(),
          ).pipe(
            Effect.mapError(
              () =>
                new EnvironmentRequirementError({
                  env,
                  diagnostics: [
                    { kind: "unknown", package: "marimo" },
                    { kind: "unknown", package: "pyzmq" },
                  ],
                }),
            ),
          );

          const diagnostics: Array<RequirementDiagnostic> = [];

          for (const pkg of packages) {
            if (pkg.version == null) {
              diagnostics.push({ kind: "missing", package: pkg.name });
            } else if (
              pkg.name === "marimo" &&
              !semver.greaterOrEqual(pkg.version, MINIMUM_MARIMO_VERSION)
            ) {
              diagnostics.push({
                kind: "outdated",
                package: "marimo",
                currentVersion: pkg.version,
                requiredVersion: MINIMUM_MARIMO_VERSION,
              });
            }
          }

          if (diagnostics.length > 0) {
            return yield* new EnvironmentRequirementError({ env, diagnostics });
          }

          return new ValidPythonEnvironemnt({ inner: env });
        });
      },
    },
  },
) {}

export class ValidPythonEnvironemnt extends Data.TaggedClass(
  "ValidPythonEnvironment",
)<{
  inner: py.Environment;
}> {
  get executable(): string {
    return this.inner.path;
  }
}

type RequirementDiagnostic =
  | { kind: "unknown"; package: string }
  | { kind: "missing"; package: string }
  | {
      kind: "outdated";
      package: string;
      currentVersion: semver.SemVer;
      requiredVersion: semver.SemVer;
    };
