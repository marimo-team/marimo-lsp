import { Command, CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";

import { Data, Effect, Stream, String } from "effect";

// Helper function to collect stream output as a string
const runString = <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
): Effect.Effect<string, E, R> =>
  stream.pipe(Stream.decodeText(), Stream.runFold(String.empty, String.concat));

class UvError extends Data.TaggedError("UvError")<{
  command: Command.Command;
  exitCode: CommandExecutor.ExitCode;
  stderr: string;
}> {}

class MissingPyProjectError extends Data.TaggedError("MissingPyProjectError")<{
  directory: string;
  cause: UvError;
}> {}

export class Uv extends Effect.Service<Uv>()("Uv", {
  dependencies: [NodeContext.layer],
  scoped: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const uv = createUv(executor);
    return {
      venv(path: string, options: { python?: string } = {}) {
        const args = ["venv", path];
        if (options.python) {
          args.push("--python", options.python);
        }
        return uv({ args });
      },
      init(path: string, options: { python?: string } = {}) {
        const args = ["init", path];
        if (options.python) {
          args.push("--python", options.python);
        }
        return uv({ args });
      },
      add(
        packages: ReadonlyArray<string>,
        options: {
          readonly directory: string;
        },
      ) {
        const { directory } = options;
        return uv({
          args: ["add", "--directory", directory, ...packages],
        }).pipe(
          Effect.catchTag("UvError", (cause) =>
            Effect.fail(
              cause.stderr.includes(
                "error: No `pyproject.toml` found in current directory or any parent directory",
              )
                ? new MissingPyProjectError({ directory, cause })
                : cause,
            ),
          ),
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
        });
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
    return stdout;
  });
}
