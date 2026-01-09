import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import { Data, Effect, type ParseResult, Schema } from "effect";
import { SemVerFromString } from "../schemas.ts";

export const MINIMUM_MARIMO_VERSION = {
  major: 0,
  minor: 19,
  patch: 0,
} satisfies semver.SemVer;

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
          ).pipe(
            Command.string,
            Effect.andThen(Schema.decodeUnknown(Schema.parseJson(EnvCheck))),
            Effect.catchTag(
              "SystemError",
              Effect.fnUntraced(function* (error) {
                const exists = yield* fs.exists(env.path);
                return yield* exists
                  ? error
                  : new InvalidExecutableError({ env });
              }),
            ),
            Effect.catchAll(
              (cause) => new EnvironmentInspectionError({ env, cause }),
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
