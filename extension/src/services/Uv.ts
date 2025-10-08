import { Command, CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { Data, Effect, Stream, String } from "effect";
import { assert } from "../assert.ts";

// Helper function to collect stream output as a string
const runString = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<string, E, R> =>
  stream.pipe(Stream.decodeText(), Stream.runFold(String.empty, String.concat));

class UvError extends Data.TaggedError("UvError")<{
  command: Command.Command;
  exitCode?: CommandExecutor.ExitCode;
  stderr: string;
}> {}

class MissingPyProjectError extends Data.TaggedError("MissingPyProjectError")<{
  directory: string;
  cause: UvError;
}> {}

class MissingPep723MetadataError extends Data.TaggedError(
  "MissingPep723MetadataError",
)<{
  script: string;
  cause: UvError;
}> {}

export class Uv extends Effect.Service<Uv>()("Uv", {
  dependencies: [NodeContext.layer],
  scoped: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const uv = createUv(executor);
    return {
      venv(path: string, options: { python?: string; clear?: true } = {}) {
        const args = ["venv", path];
        if (options.python) {
          args.push("--python", options.python);
        }
        if (options.clear) {
          args.push("--clear");
        }
        return uv({ args }).pipe(Effect.andThen(Effect.void));
      },
      currentDeps(options: { script: string }) {
        return uv({
          args: ["tree", "--script", options.script, "-d", "0", "--quiet"],
        }).pipe(
          Effect.catchTag("UvError", (cause) =>
            Effect.fail(
              cause.stderr.includes("does not contain a PEP 723 metadata")
                ? new MissingPep723MetadataError({
                    script: options.script,
                    cause,
                  })
                : cause,
            ),
          ),
          Effect.map((e) => e.stdout),
        );
      },
      init(path: string, options: { python?: string } = {}) {
        const args = ["init", path];
        if (options.python) {
          args.push("--python", options.python);
        }
        return uv({ args }).pipe(Effect.andThen(Effect.void));
      },
      sync(options: { script: string }) {
        return Effect.andThen(
          uv({ args: ["sync", "--script", options.script] }),
          ({ stderr }) => {
            const match =
              stderr.match(/Using script environment at: (.+)/m) ??
              stderr.match(/Creating script environment at: (.+)/m);
            const path = match?.[1];
            assert(path, `Expected path from uv, got: stderr=${stderr}`);
            return path;
          },
        );
      },
      add(
        packages: ReadonlyArray<string>,
        options: {
          readonly directory?: string;
          readonly script?: string;
          readonly noSync?: boolean;
        } = {},
      ) {
        const args = ["add", ...packages];
        if (options.directory) {
          args.push("--directory", options.directory);
        }
        if (options.script) {
          args.push("--script", options.script);
        }
        if (options.noSync) {
          args.push("--no-sync");
        }
        return uv({ args }).pipe(
          Effect.catchTag("UvError", (cause) =>
            Effect.fail(
              cause.stderr.includes(
                "error: No `pyproject.toml` found in current directory or any parent directory",
              )
                ? new MissingPyProjectError({
                    directory: options.directory ?? "",
                    cause,
                  })
                : cause,
            ),
          ),
          Effect.andThen(Effect.void),
        );
      },
      pipInstall(
        packages: ReadonlyArray<string>,
        options: {
          readonly venv: string;
        },
      ) {
        return uv({
          args: ["pip", "install", ...packages],
          env: {
            VIRTUAL_ENV: options.venv,
          },
        }).pipe(Effect.andThen(Effect.void));
      },
    };
  }),
}) {}

function createUv(executor: CommandExecutor.CommandExecutor) {
  return Effect.fn("uv")(function* (options: {
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string>;
  }) {
    const command = Command.make("uv", ...options.args).pipe(
      Command.env({ NO_COLOR: "1", ...options.env }),
    );
    yield* Effect.logDebug("Running command").pipe(
      Effect.annotateLogs({ command }),
    );
    const [exitCode, stdout, stderr] = yield* command.pipe(
      Command.start,
      Effect.provideService(CommandExecutor.CommandExecutor, executor),
      Effect.flatMap((process) =>
        Effect.all(
          [
            // Waits for the process to exit and returns
            // the ExitCode of the command that was run
            process.exitCode,
            runString(process.stdout),
            runString(process.stderr),
          ],
          { concurrency: 3 },
        ),
      ),
      Effect.scoped,
    );
    if (exitCode !== 0) {
      return yield* new UvError({
        command,
        exitCode,
        stderr,
      });
    }
    return { stdout, stderr };
  });
}
