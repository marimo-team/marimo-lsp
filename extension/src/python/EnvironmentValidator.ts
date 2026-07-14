import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import type { PlatformError } from "@effect/platform/Error";
import * as semver from "@std/semver";
import type * as py from "@vscode/python-extension";
import {
  Cache,
  Data,
  Duration,
  Effect,
  Equal,
  Hash,
  Option,
  type ParseResult,
  Schema,
  Stream,
  String,
} from "effect";

import { MINIMUM_MARIMO_KERNEL_VERSION } from "../constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import { SemVerFromString } from "../schemas/SemVerFromString.ts";
import { PythonEnvInvalidation } from "./PythonEnvInvalidation.ts";

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

/**
 * Upper bound on the environment-inspection subprocess. Spawning the
 * interpreter can stall indefinitely on pathological filesystems (e.g. a
 * venv on `/mnt/c` under WSL2); without a bound the cell execution that
 * awaits validation hangs forever with no way to interrupt it.
 *
 * The check is a preflight nicety, not a correctness gate — a timeout is
 * inconclusive, so we warn and proceed rather than block the run. If
 * marimo genuinely isn't importable, the kernel launch fails with a clear
 * error anyway.
 */
const INSPECTION_TIMEOUT = Duration.seconds(10);

/**
 * Cache key comparing environments by interpreter path while carrying the
 * full `py.Environment` for the cache's lookup function.
 */
class EnvironmentKey implements Equal.Equal {
  readonly env: py.Environment;
  constructor(env: py.Environment) {
    this.env = env;
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof EnvironmentKey && that.env.path === this.env.path;
  }
  [Hash.symbol](): number {
    return Hash.string(this.env.path);
  }
}

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
 *
 * using `env.executable`.
 *
 * Successful validations are cached per interpreter path — the check spawns
 * a subprocess that imports marimo, which costs seconds per run on slow
 * platforms, and `validate` sits on the hot path of every cell execution.
 * Failures are never cached, and the whole cache is dropped on
 * `PythonEnvInvalidation` events (package installs, interpreter changes).
 * An inspection that times out is treated (and cached) as valid with a
 * warning, so a slow environment pays the wait once instead of on every
 * run.
 */
export class EnvironmentValidator extends Effect.Service<EnvironmentValidator>()(
  "EnvironmentValidator",
  {
    dependencies: [NodeContext.layer, PythonEnvInvalidation.Default],
    scoped: Effect.gen(function* () {
      const executor = yield* CommandExecutor.CommandExecutor;
      const fs = yield* FileSystem.FileSystem;
      const code = yield* VsCode;
      const invalidation = yield* PythonEnvInvalidation;

      const EnvCheck = Schema.Array(
        Schema.Struct({
          name: Schema.String,
          version: Schema.NullOr(SemVerFromString),
        }),
      );

      const inspect = Effect.fnUntraced(function* (env: py.Environment) {
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
          Effect.timeoutOption(INSPECTION_TIMEOUT),
          Effect.provideService(CommandExecutor.CommandExecutor, executor),
        );

        if (Option.isNone(packages)) {
          yield* Effect.logWarning(
            "Environment inspection timed out; running without verification",
          ).pipe(Effect.annotateLogs({ executable: env.path }));
          yield* Effect.forkDaemon(
            code.window.showWarningMessage(
              `Could not verify marimo in ${env.path} (timed out); running anyway. ` +
                `This can happen when the environment lives on a slow filesystem (e.g. a Windows drive mounted in WSL2).`,
            ),
          );
          return new ValidPythonEnvironment({ inner: env });
        }

        const diagnostics: Array<RequirementDiagnostic> = [];

        for (const pkg of packages.value) {
          if (pkg.version == null) {
            diagnostics.push({ kind: "missing", package: pkg.name });
          } else if (
            pkg.name === "marimo" &&
            !semver.greaterOrEqual(pkg.version, MINIMUM_MARIMO_KERNEL_VERSION)
          ) {
            diagnostics.push({
              kind: "outdated",
              package: "marimo",
              currentVersion: pkg.version,
              requiredVersion: MINIMUM_MARIMO_KERNEL_VERSION,
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
      });

      const cache = yield* Cache.make({
        capacity: 32,
        timeToLive: Duration.infinity,
        lookup: (key: EnvironmentKey) => inspect(key.env),
      });

      yield* Effect.forkScoped(
        invalidation
          .changes()
          .pipe(
            Stream.runForEach((reason) =>
              Effect.logDebug("Invalidating environment validation cache").pipe(
                Effect.annotateLogs({ reason }),
                Effect.andThen(cache.invalidateAll),
              ),
            ),
          ),
      );

      return {
        validate: Effect.fn("EnvironmentValidator.validate")(function* (
          env: py.Environment,
        ) {
          const key = new EnvironmentKey(env);
          // Only reuse successes: drop failed entries so a just-fixed
          // environment (e.g. marimo installed in a terminal) is re-checked
          // on the next run. Concurrent lookups for the same key still
          // dedupe while the inspection is in flight.
          return yield* cache
            .get(key)
            .pipe(Effect.tapError(() => cache.invalidate(key)));
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
