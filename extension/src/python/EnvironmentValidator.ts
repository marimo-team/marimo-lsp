import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import type { PlatformError } from "@effect/platform/Error";
import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Data, Effect, type ParseResult, Schema, Stream, String } from "effect";

import { MINIMUM_MARIMO_VERSION } from "../constants.ts";
import { SemVerFromString } from "../lib/SemVerFromString.ts";

class InvalidExecutableError extends Data.TaggedError(
  "InvalidExecutableError",
)<{
  readonly env: py.Environment;
}> {}

class EnvironmentInspectionError extends Data.TaggedError(
  "EnvironmentInspectionError",
)<{
  readonly env: py.Environment;
  readonly cause?:
    | PlatformError
    | ParseResult.ParseError
    | InvalidExecutableError;
  readonly stdout?: string;
  readonly stderr?: string;
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
    dependencies: [NodeContext.layer],
    effect: Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const fs = yield* FileSystem.FileSystem;

      const EnvCheck = Schema.Array(
        Schema.Struct({
          name: Schema.String,
          version: Schema.NullOr(SemVerFromString),
        }),
      );

      return {
        validate: Effect.fn(function* (env: py.Environment) {
          const packages = yield* Command.make(
            env.path,
            "-c",
            `\
import json, sys, io

# Redirect stdout during imports so that noisy packages
# (e.g. those that print warnings on import) don't pollute
# the JSON we emit.
_real_stdout = sys.stdout
sys.stdout = io.StringIO()

packages = []

try:
    import marimo
    packages.append({"name":"marimo","version":marimo.__version__})
except Exception:
    packages.append({"name":"marimo","version":None})

try:
    import zmq
    packages.append({"name":"pyzmq","version":zmq.__version__})
except Exception:
    packages.append({"name":"pyzmq","version":None})

# Restore stdout and emit the result
sys.stdout = _real_stdout
print(json.dumps(packages), flush=True)`,
          ).pipe(
            Command.start,
            Effect.flatMap((process) =>
              Effect.all(
                [
                  process.exitCode,
                  collectString(process.stdout),
                  collectString(process.stderr),
                ],
                { concurrency: 3 },
              ),
            ),
            Effect.scoped,
            Effect.andThen(([exitCode, stdout, stderr]) => {
              if (exitCode !== 0) {
                return Effect.fail(
                  new EnvironmentInspectionError({ env, stdout, stderr }),
                );
              }
              return Schema.decodeUnknown(Schema.parseJson(EnvCheck))(
                stdout,
              ).pipe(
                Effect.catchAll(
                  (cause) =>
                    new EnvironmentInspectionError({
                      env,
                      cause,
                      stdout,
                      stderr,
                    }),
                ),
              );
            }),
            Effect.catchTag(
              "SystemError",
              Effect.fn(function* (error) {
                const exists = yield* fs.exists(env.path);
                return yield* exists
                  ? error
                  : new InvalidExecutableError({ env });
              }),
            ),
            Effect.catchTag(
              "BadArgument",
              Effect.fn(function* (error) {
                const exists = yield* fs.exists(env.path);
                return yield* exists
                  ? error
                  : new InvalidExecutableError({ env });
              }),
            ),
            Effect.catchAll((cause) =>
              cause._tag === "EnvironmentInspectionError"
                ? cause
                : new EnvironmentInspectionError({ env, cause }),
            ),
            Effect.provideService(CommandExecutor.CommandExecutor, executor),
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
            return yield* new EnvironmentRequirementError({
              env,
              diagnostics,
            });
          }

          return new ValidPythonEnvironment({ inner: env });
        }),
      };
    }),
  },
) {}

export class ValidPythonEnvironment extends Data.TaggedClass(
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

/** Collect a stream of Uint8Array chunks into a single string. */
function collectString<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<string, E, R> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.runFold(String.empty, String.concat),
  );
}
