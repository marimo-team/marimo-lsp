import { Command, CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Data, Effect, Stream, String } from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import { VsCode } from "./VsCode.ts";

class UvExecutionError extends Data.TaggedError("UvExecutionError")<{
  command: Command.Command;
  cause: PlatformError;
}> {}

class UvUnknownError extends Data.TaggedError("UvUnknownError")<{
  command: Command.Command;
  exitCode?: CommandExecutor.ExitCode;
  stderr: string;
}> {}

class UvMissingPyProjectError extends Data.TaggedError(
  "UvMissingPyProjectError",
)<{
  directory: string;
  cause: UvUnknownError;
}> {
  static refine(directory: string, cause: UvUnknownError) {
    return Effect.fail(
      cause.stderr.includes(
        "error: No `pyproject.toml` found in current directory or any parent directory",
      )
        ? new UvMissingPyProjectError({ directory, cause })
        : cause,
    );
  }
}

class UvMissingPep723MetadataError extends Data.TaggedError(
  "UvMissingPep723MetadataError",
)<{
  script: string;
  cause: UvUnknownError;
}> {
  static refine(script: string, cause: UvUnknownError) {
    return Effect.fail(
      cause.stderr.includes("does not contain a PEP 723 metadata")
        ? new UvMissingPep723MetadataError({ script, cause })
        : cause,
    );
  }
}

class UvResolutionError extends Data.TaggedError("UvResolutionError")<{
  cause: UvUnknownError;
}> {
  static refine(cause: UvUnknownError) {
    return Effect.fail(
      cause.stderr.includes("No solution found when resolving dependencies")
        ? new UvResolutionError({ cause })
        : cause,
    );
  }
}

export class Uv extends Effect.Service<Uv>()("Uv", {
  dependencies: [NodeContext.layer],
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const executor = yield* CommandExecutor.CommandExecutor;
    const channel = yield* code.window.createOutputChannel("marimo (uv)");
    const uv = createUv(executor, channel);

    return {
      getCacheDir: () =>
        uv({ args: ["cache", "dir"] }).pipe(Effect.map((e) => e.stdout.trim())),
      channel: {
        name: channel.name,
        show: channel.show.bind(channel),
      },
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
          Effect.catchTag("UvUnknownError", UvResolutionError.refine),
          Effect.catchTag(
            "UvUnknownError",
            UvMissingPep723MetadataError.refine.bind(null, options.script),
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
      syncScript(options: { script: string }) {
        return Effect.andThen(
          uv({ args: ["sync", "--script", options.script] }),
          ({ stderr }) => {
            const match =
              stderr.match(/Using script environment at: (.+)/m) ??
              stderr.match(/Updating script environment at: (.+)/m) ??
              stderr.match(/Creating script environment at: (.+)/m);
            const path = match?.[1];
            assert(path, `Expected path from uv, got: stderr=${stderr}`);
            return path;
          },
        ).pipe(Effect.catchTag("UvUnknownError", UvResolutionError.refine));
      },
      addScript(options: {
        script: string;
        packages: ReadonlyArray<string>;
        noSync?: boolean;
      }) {
        const args = ["add", ...options.packages, "--script", options.script];
        if (options.noSync) {
          args.push("--no-sync");
        }
        return uv({ args });
      },
      addProject(options: {
        directory: string;
        packages: ReadonlyArray<string>;
      }) {
        const args = [
          "add",
          ...options.packages,
          "--directory",
          options.directory,
        ];
        return uv({ args }).pipe(
          Effect.catchTag("UvUnknownError", UvResolutionError.refine),
          Effect.catchTag(
            "UvUnknownError",
            UvMissingPyProjectError.refine.bind(null, options.directory),
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

function createUv(
  executor: CommandExecutor.CommandExecutor,
  channel: vscode.OutputChannel,
) {
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
            runString(process.stdout, channel),
            runString(process.stderr, channel),
          ],
          { concurrency: 3 },
        ),
      ),
      Effect.scoped,
      Effect.catchTags({
        BadArgument: (cause) => new UvExecutionError({ command, cause }),
        SystemError: (cause) => new UvExecutionError({ command, cause }),
      }),
    );
    if (exitCode !== 0) {
      return yield* new UvUnknownError({ command, exitCode, stderr });
    }
    return { stdout, stderr };
  });
}

/** Helper to collect stream output as a string */
function runString<E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  channel: vscode.OutputChannel,
): Effect.Effect<string, E, R> {
  return stream.pipe(
    Stream.decodeText(),
    Stream.tap((text) => {
      // Forward all logs to the marimo (uv) channel
      channel.append(text);
      return Effect.void;
    }),
    Stream.runFold(String.empty, String.concat),
  );
}
