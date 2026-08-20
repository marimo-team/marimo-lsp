import { NodeServices } from "@effect/platform-node";
import * as semver from "@std/semver";
import {
  Cache,
  Context,
  Data,
  Duration,
  Effect,
  Equal,
  FileSystem,
  Hash,
  Layer,
  Option,
  Schema,
  Stream,
  String,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { MINIMUM_MARIMO_KERNEL_VERSION } from "../constants.ts";
import { VsCode } from "../platform/VsCode.ts";
import { SemVerFromString } from "../schemas/SemVerFromString.ts";
import { PythonEnvInvalidation } from "./PythonEnvInvalidation.ts";

interface PythonEnvironment {
  readonly path: string;
}

class InvalidExecutableError extends Data.TaggedError(
  "InvalidExecutableError",
)<{
  readonly env: PythonEnvironment;
}> {}

class EnvironmentInspectionError extends Data.TaggedError(
  "EnvironmentInspectionError",
)<{
  readonly env: PythonEnvironment;
  readonly cause?: PlatformError | Schema.SchemaError | InvalidExecutableError;
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
 * environment for the cache's lookup function.
 */
class EnvironmentKey implements Equal.Equal {
  readonly env: PythonEnvironment;
  constructor(env: PythonEnvironment) {
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
  readonly env: PythonEnvironment;
  readonly diagnostics: ReadonlyArray<RequirementDiagnostic>;
}> {}

/**
 * Validates Python environments for marimo extension compatibility.
 *
 * Checks for:
 *
 *   - marimo (with version requirement)
 *
 * by invoking the interpreter at `env.path`.
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
export class EnvironmentValidator extends Context.Service<EnvironmentValidator>()(
  "EnvironmentValidator",
  {
    make: Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fs = yield* FileSystem.FileSystem;
      const code = yield* VsCode;
      const invalidation = yield* PythonEnvInvalidation;

      const EnvCheck = Schema.Array(
        Schema.Struct({
          name: Schema.String,
          version: Schema.NullOr(Schema.String),
        }),
      );

      const inspect = Effect.fnUntraced(function* (env: PythonEnvironment) {
        const packages = yield* ChildProcess.make(env.path, [
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
        ]).pipe(
          Effect.flatMap((handle) =>
            Effect.all(
              [
                handle.exitCode,
                collectString(handle.stdout),
                collectString(handle.stderr),
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
            return Schema.decodeUnknownEffect(Schema.fromJsonString(EnvCheck))(
              stdout,
            ).pipe(
              Effect.catch(
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
            "PlatformError",
            Effect.fn(function* (error) {
              const exists = yield* fs.exists(env.path);
              return yield* exists
                ? error
                : new InvalidExecutableError({ env });
            }),
          ),
          Effect.catch((cause) =>
            cause._tag === "EnvironmentInspectionError"
              ? cause
              : new EnvironmentInspectionError({ env, cause }),
          ),
          Effect.timeoutOption(INSPECTION_TIMEOUT),
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            spawner,
          ),
        );

        if (Option.isNone(packages)) {
          yield* Effect.logWarning(
            "Environment inspection timed out; running without verification",
          ).pipe(Effect.annotateLogs({ executable: env.path }));
          yield* Effect.forkDetach(
            code.window.showWarningMessage(
              `Could not verify marimo in ${env.path} (timed out); running anyway. ` +
                `This can happen when the environment lives on a slow filesystem (e.g. a Windows drive mounted in WSL2).`,
            ),
          );
          return new ValidPythonEnvironment({
            executable: env.path,
            marimoVersion: Option.none(),
          });
        }

        const diagnostics: Array<RequirementDiagnostic> = [];
        let marimoVersion = Option.none<string>();

        for (const pkg of packages.value) {
          if (pkg.version == null) {
            diagnostics.push({ kind: "missing", package: pkg.name });
          } else if (pkg.name === "marimo") {
            const parsed = Schema.decodeOption(SemVerFromString)(pkg.version);
            if (Option.isNone(parsed)) {
              diagnostics.push({ kind: "unknown", package: pkg.name });
              continue;
            }
            if (
              !semver.greaterOrEqual(
                parsed.value,
                MINIMUM_MARIMO_KERNEL_VERSION,
              )
            ) {
              diagnostics.push({
                kind: "outdated",
                package: "marimo",
                currentVersion: parsed.value,
                requiredVersion: MINIMUM_MARIMO_KERNEL_VERSION,
              });
              continue;
            }
            marimoVersion = Option.some(pkg.version);
          }
        }

        if (diagnostics.length > 0) {
          return yield* new EnvironmentRequirementError({
            env,
            diagnostics,
          });
        }

        return new ValidPythonEnvironment({
          executable: env.path,
          marimoVersion,
        });
      });

      const cache = yield* Cache.make({
        capacity: 32,
        timeToLive: Duration.infinity,
        lookup: (key: EnvironmentKey) => inspect(key.env),
      });

      yield* Effect.forkScoped(
        invalidation.changes.pipe(
          Stream.runForEach((reason) =>
            Effect.logDebug("Invalidating environment validation cache").pipe(
              Effect.annotateLogs({ reason }),
              Effect.andThen(Cache.invalidateAll(cache)),
            ),
          ),
        ),
      );

      return {
        validateFresh: inspect,
        validate: Effect.fn("EnvironmentValidator.validate")(function* (
          env: PythonEnvironment,
        ) {
          const key = new EnvironmentKey(env);
          // Only reuse successes: drop failed entries so a just-fixed
          // environment (e.g. marimo installed in a terminal) is re-checked
          // on the next run. Concurrent lookups for the same key still
          // dedupe while the inspection is in flight.
          return yield* Cache.get(cache, key).pipe(
            Effect.tapError(() => Cache.invalidate(cache, key)),
          );
        }),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([NodeServices.layer, PythonEnvInvalidation.layer]),
  );
}

/**
 * A validated Python environment and the exact marimo version string observed
 * by its inspection. `validate` caches this value; `validateFresh` does not.
 */
export class ValidPythonEnvironment extends Data.TaggedClass(
  "ValidPythonEnvironment",
)<{
  readonly executable: string;
  readonly marimoVersion: Option.Option<string>;
}> {}

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
    Stream.runFold(() => String.empty, String.concat),
  );
}
