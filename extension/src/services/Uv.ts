import * as NodeChildProcess from "node:child_process";
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
import { Sentry } from "./Sentry.ts";
import { Telemetry } from "./Telemetry.ts";
import { VsCode } from "./VsCode.ts";

export const UvBin = Data.taggedEnum<UvBin>();
type UvBin = Data.TaggedEnum<{
  Default: {
    readonly executable: "uv" | "uv.exe";
    readonly version: Option.Option<string>;
  };
  Configured: {
    readonly executable: string;
    readonly version: Option.Option<string>;
  };
  Discovered: {
    readonly executable: string;
    readonly version: Option.Option<string>;
  };
}>;

class UvNotInstalledError extends Data.TaggedError("UvNotInstalledError")<{
  bin: UvBin;
}> {}

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
    const telemetry = yield* Effect.serviceOption(Telemetry);
    const sentry = yield* Effect.serviceOption(Sentry);
    const executor = yield* CommandExecutor.CommandExecutor;
    const channel = yield* code.window.createOutputChannel("marimo (uv)");

    // Eagerly verify UV is installed - this runs during layer construction
    const uvBinary = yield* findUvBin(yield* config.uv.path).pipe(
      Effect.catchTag("UvNotInstalledError", (error) =>
        handleUvNotInstalled(error, code, telemetry),
      ),
    );

    if (Option.isSome(sentry)) {
      yield* sentry.value.setTag(
        "uv.version",
        Option.getOrElse(uvBinary.version, () => "unknown"),
      );
    }

    const uv = createUv(uvBinary, executor, channel);

    return {
      bin: uvBinary,
      getCacheDir: () =>
        Effect.map(uv({ args: ["cache", "dir"] }), (e) => e.stdout.trim()),
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
        return Effect.andThen(uv({ args }), Effect.void);
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
        return Effect.andThen(uv({ args }), Effect.void);
      },
      initScript({ script }: { script: string }) {
        return Effect.andThen(
          uv({ args: ["init", "--script", script] }),
          Effect.void,
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
        return Effect.andThen(
          uv({
            args: ["pip", "install", ...packages],
            env: {
              VIRTUAL_ENV: options.venv,
            },
          }),
          Effect.void,
        );
      },
    };
  }),
}) {}

function createUv(
  bin: UvBin,
  executor: CommandExecutor.CommandExecutor,
  channel: vscode.OutputChannel,
) {
  return Effect.fn("uv")(function* (options: {
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string>;
  }) {
    const command = Command.make(bin.executable, ...options.args).pipe(
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
  let bin: UvBin;

  if (Option.isSome(userConfigPath)) {
    yield* Effect.logDebug(
      `Using user-configured uv path: ${userConfigPath.value}`,
    );
    bin = UvBin.Configured({
      executable: userConfigPath.value,
      version: Option.none(),
    });
  } else {
    // Check default install locations
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

    let found: UvBin | null = null;
    for (const path of defaultPaths) {
      const exists = yield* Effect.try(() => NodeFs.existsSync(path)).pipe(
        Effect.orElse(() => Effect.succeed(false)),
      );
      if (exists) {
        yield* Effect.logDebug(`Found uv binary at default location: ${path}`);
        found = UvBin.Discovered({
          executable: path,
          version: Option.none(),
        });
        break;
      }
    }

    if (found) {
      bin = found;
    } else {
      yield* Effect.logDebug("uv binary not found in default locations");
      bin = UvBin.Default({
        executable: binName,
        version: Option.none(),
      });
    }
  }

  // Validate that the binary actually works
  const version = getUvVersion(bin);
  if (Option.isNone(version)) {
    yield* Effect.logError(
      `UV is not available. Binary: '${bin.executable}'. PATH: ${NodeProcess.env.PATH ?? "(not set)"}`,
    );
    return yield* new UvNotInstalledError({ bin });
  }

  yield* Effect.logInfo(`UV verified: ${version.value}`);
  return UvBin.$match(bin, {
    Default: (b) => UvBin.Default({ ...b, version }),
    Configured: (b) => UvBin.Configured({ ...b, version }),
    Discovered: (b) => UvBin.Discovered({ ...b, version }),
  });
});

/**
 * Gets the UV version by running `uv --version`.
 * Returns None if UV is not installed or not working.
 */
function getUvVersion(bin: UvBin): Option.Option<string> {
  try {
    const version = NodeChildProcess.execSync(`${bin.executable} --version`, {
      encoding: "utf8",
    });
    return Option.some(version.trim());
  } catch {
    return Option.none();
  }
}

/**
 * Handles UvNotInstalledError by showing a modal dialog with options.
 * Dies after user interaction to prevent extension from continuing without UV.
 */
const handleUvNotInstalled = Effect.fn("handleUvNotInstalled")(function* (
  error: UvNotInstalledError,
  code: VsCode,
  telemetry: Option.Option<Telemetry>,
) {
  if (Option.isSome(telemetry)) {
    yield* telemetry.value.capture("uv_missing", { binType: error.bin._tag });
  }

  const errorMessage = UvBin.$match(error.bin, {
    Configured: (bin) =>
      `The marimo extension requires uv.\n\nThe configured path "${bin.executable}" was not found.`,
    Default: () => "The marimo extension requires uv.",
    Discovered: (bin) =>
      `The marimo extension requires uv.\n\nFound "${bin.executable}" but it failed to execute.`,
  });

  const choice = yield* code.window.showErrorMessage(errorMessage, {
    modal: true,
    items: UvBin.$is("Configured")(error.bin)
      ? (["Open Settings"] as const)
      : (["Install uv", "Open Settings"] as const),
  });

  if (Option.isSome(choice) && choice.value === "Install uv") {
    if (Option.isSome(telemetry)) {
      yield* telemetry.value.capture("uv_install_clicked");
    }

    // Create hidden terminal so Python extension doesn't auto-activate environments
    const terminal = yield* code.window.createTerminal({
      name: "Install uv",
      hideFromUser: true,
    });

    /// Send install command from uv docs https://docs.astral.sh/uv/getting-started/installation/
    terminal.sendText(
      NodeProcess.platform === "win32"
        ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        : "curl -LsSf https://astral.sh/uv/install.sh | sh",
      /* Should execute */ false,
    );

    // Show to user to accept
    terminal.show();

    // Prompt user to reload after installation
    const reload = yield* code.window.showInformationMessage(
      "After installing uv, reload the window to activate the marimo extension.",
      { items: ["Reload Window"] },
    );

    if (Option.isSome(reload) && reload.value === "Reload Window") {
      yield* code.commands.executeCommand("workbench.action.reloadWindow");
    }
  }

  if (Option.isSome(choice) && choice.value === "Open Settings") {
    yield* code.commands.executeCommand(
      "workbench.action.openSettings",
      "marimo.uv.path",
    );
  }

  // Die to prevent extension from continuing without UV
  return yield* Effect.die(error);
});
