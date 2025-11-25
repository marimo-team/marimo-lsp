import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { Command, CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Data, Effect, Option, Stream, String } from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import { Config } from "./Config.ts";
import { VsCode } from "./VsCode.ts";

export const UvBin = Data.taggedEnum<UvBin>();
type UvBin = Data.TaggedEnum<{
  Default: { readonly executable: "uv" | "uv.exe" };
  Configured: { readonly executable: string };
  Discovered: { readonly executable: string };
}>;

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
  dependencies: [NodeContext.layer, Config.Default],
  scoped: Effect.gen(function* () {
    const code = yield* VsCode;
    const config = yield* Config;
    const executor = yield* CommandExecutor.CommandExecutor;
    const channel = yield* code.window.createOutputChannel("marimo (uv)");

    const uvBinary = yield* findUvBin(yield* config.uv.path);
    const uv = createUv(uvBinary.executable, executor, channel);

    return {
      bin: uvBinary,
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
      initScript({ script }: { script: string }) {
        return uv({ args: ["init", "--script", script] }).pipe(
          Effect.andThen(Effect.void),
        );
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
        ).pipe(
          Effect.catchTag(
            "UvUnknownError",
            UvMissingPep723MetadataError.refine.bind(null, options.script),
          ),
          Effect.catchTag("UvUnknownError", UvResolutionError.refine),
        );
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
  uvBinary: string,
  executor: CommandExecutor.CommandExecutor,
  channel: vscode.OutputChannel,
) {
  return Effect.fn("uv")(function* (options: {
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string>;
  }) {
    const command = Command.make(uvBinary, ...options.args).pipe(
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

const findUvBin = Effect.fn("findUvBin")(function* (
  userConfigPath: Option.Option<string>,
) {
  if (Option.isSome(userConfigPath)) {
    yield* Effect.logDebug(
      `Using user-configured uv path: ${userConfigPath.value}`,
    );
    return UvBin.Configured({ executable: userConfigPath.value });
  }

  // then check default install locations
  const homedir = NodeOs.homedir();
  const binName = NodeProcess.platform === "win32" ? "uv.exe" : "uv";
  const defaultPaths =
    NodeProcess.platform === "win32"
      ? [
          NodePath.join(homedir, ".local", "bin", binName),
          NodePath.join(homedir, ".cargo", "bin", binName),
        ]
      : [
          NodePath.join(homedir, ".local", "bin", binName),
          NodePath.join(homedir, ".cargo", "bin", binName),
          "/opt/homebrew/bin/uv", // Apple Silicon Homebrew
        ];

  // should probably use Command but for simplicity just check sync
  for (const path of defaultPaths) {
    const exists = yield* Effect.try(() => NodeFs.existsSync(path)).pipe(
      Effect.orElse(() => Effect.succeed(false)),
    );
    if (exists) {
      yield* Effect.logDebug(`Found uv binary at default location: ${path}`);
      return UvBin.Discovered({ executable: path });
    }
  }

  yield* Effect.logDebug("uv binary not found in default locations");
  return UvBin.Default({ executable: binName });
});
