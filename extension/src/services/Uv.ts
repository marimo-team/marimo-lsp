import { Command, CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";

import { Data, Effect, Stream, String } from "effect";
import { LoggerLive } from "../layers/Logger";

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

export class Uv extends Effect.Service<Uv>()("Uv", {
  dependencies: [NodeContext.layer, LoggerLive],
  scoped: Effect.gen(function* () {
    const executor = yield* CommandExecutor.CommandExecutor;
    const uv = createUv(executor);
    return {
      pipInstall(
        packages: ReadonlyArray<string>,
        options: { readonly target: string },
      ) {
        return uv("pip", "install", "--target", options.target, ...packages);
      },
    };
  }),
}) {}

function createUv(executor: CommandExecutor.CommandExecutor) {
  return Effect.fn("uv")(function* (...args: Array<string>) {
    const command = Command.make("uv", ...args);
    const [exitCode, stdout, stderr] = yield* command.pipe(
      Command.env({ NO_COLOR: "1" }),
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
