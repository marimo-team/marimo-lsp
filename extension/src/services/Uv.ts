import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";
import { Command, CommandExecutor } from "@effect/platform";
import type { PlatformError } from "@effect/platform/Error";
import { NodeContext } from "@effect/platform-node";
import { Data, Effect, Option, Schema, Stream, String } from "effect";
import type * as vscode from "vscode";
import { assert } from "../assert.ts";
import { Config } from "./Config.ts";
import { Sentry } from "./Sentry.ts";
import { Telemetry } from "./Telemetry.ts";
import { VsCode } from "./VsCode.ts";

export const UvBin = Data.taggedEnum<UvBin>();
type UvBin = Data.TaggedEnum<{
  Bundled: {
    readonly executable: string;
    readonly version: Option.Option<VersionInfo>;
  };
  Default: {
    readonly executable: "uv" | "uv.exe";
    readonly version: Option.Option<VersionInfo>;
  };
  Configured: {
    readonly executable: string;
    readonly version: Option.Option<VersionInfo>;
  };
  Discovered: {
    readonly executable: string;
    readonly version: Option.Option<VersionInfo>;
  };
}>;

/**
 * Path to the bundled uv binary.
 * At runtime, __dirname is the dist/ directory, so we go up one level to the extension root.
 */
const BUNDLED_UV_PATH = NodePath.join(
  __dirname,
  "..",
  "bundled",
  "libs",
  "bin",
  NodeProcess.platform === "win32" ? "uv.exe" : "uv",
);

class UvExecutionError extends Data.TaggedError("UvExecutionError")<{
  bin: UvBin;
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
    const sentry = yield* Sentry;
    const telemetry = yield* Telemetry;
    const executor = yield* CommandExecutor.CommandExecutor;
    const channel = yield* code.window.createOutputChannel("marimo (uv)");

    // Eagerly verify UV is installed - this runs during layer construction
    const uvBinary = yield* findUvBin(yield* config.uv.path).pipe(
      Effect.catchTag("UvExecutionError", (error) =>
        handleUvNotInstalled(error, code, telemetry),
      ),
    );

    if (Option.isNone(uvBinary.version)) {
      yield* code.window.showWarningMessage(
        "Unable to determine uv version. Some features may not work correctly.",
      );
    }

    {
      const version = Option.match(uvBinary.version, {
        onSome: (v) => v.format(),
        onNone: () => "unknown",
      });

      yield* sentry.setTag("uv.version", version);
      yield* telemetry.capture("uv_init", { binType: uvBinary._tag, version });
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

            // uv's user_display() strips the CWD prefix from paths when possible
            // (see https://github.com/astral-sh/uv/blob/main/crates/uv-fs/src/path.rs#L80).
            // When CWD is an ancestor of the cache directory, uv outputs relative paths
            // like ".cache/uv/...".
            //
            // Since we later use the venv path to locate a Python binary from a different CWD,
            // a relative path breaks our logic later. Fix this by ensuring our returned path is absolute
            return NodePath.resolve(path);
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
        BadArgument: (cause) => new UvExecutionError({ bin, command, cause }),
        SystemError: (cause) => new UvExecutionError({ bin, command, cause }),
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
  const code = yield* VsCode;
  const bundledExists = NodeFs.existsSync(BUNDLED_UV_PATH);

  // Priority 1: Untrusted workspace with bundled binary - use bundled for security
  if (!code.workspace.isTrusted() && bundledExists) {
    yield* Effect.logDebug(
      `Workspace is not trusted, using bundled uv: ${BUNDLED_UV_PATH}`,
    );
    bin = UvBin.Bundled({
      executable: BUNDLED_UV_PATH,
      version: Option.none(),
    });
  }
  // Priority 2: User-configured path
  else if (Option.isSome(userConfigPath)) {
    yield* Effect.logDebug(
      `Using user-configured uv path: ${userConfigPath.value}`,
    );
    bin = UvBin.Configured({
      executable: userConfigPath.value,
      version: Option.none(),
    });
  }
  // Priority 3: Bundled binary
  else if (bundledExists) {
    yield* Effect.logDebug(`Using bundled uv: ${BUNDLED_UV_PATH}`);
    bin = UvBin.Bundled({
      executable: BUNDLED_UV_PATH,
      version: Option.none(),
    });
  }
  // Priority 4: Check default install locations
  else {
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
  const version = yield* getUvVersion(bin);

  if (Option.isNone(version)) {
    yield* Effect.logWarning(
      `Unable to parse uv version for ${bin.executable}; proceeding with unknown version`,
    );
  }

  const sourceDescription = UvBin.$match(bin, {
    Bundled: () => "bundled",
    Configured: () => "configured",
    Discovered: () => "discovered",
    Default: () => "PATH",
  });

  const versionStr = Option.match(version, {
    onSome: (v) => v.format(),
    onNone: () => "unknown",
  });

  yield* Effect.logInfo(
    `Using ${sourceDescription} uv: ${bin.executable} ${versionStr}`,
  );

  return UvBin.$match(bin, {
    Bundled: (b) => UvBin.Bundled({ ...b, version }),
    Default: (b) => UvBin.Default({ ...b, version }),
    Configured: (b) => UvBin.Configured({ ...b, version }),
    Discovered: (b) => UvBin.Discovered({ ...b, version }),
  });
});

class VersionInfo extends Schema.Class<VersionInfo>("VersionInfo")({
  package_name: Schema.String,
  version: Schema.String,
  commit_info: Schema.NullOr(
    Schema.Struct({
      short_commit_hash: Schema.String,
      commit_hash: Schema.String,
      commit_date: Schema.String,
      last_tag: Schema.NullOr(Schema.String),
      commits_since_last_tag: Schema.Int,
    }),
  ),
}) {
  format() {
    if (!this.commit_info) {
      return this.version;
    }
    return `${this.version} (${this.commit_info.short_commit_hash} ${this.commit_info.commit_date})`;
  }
}

function getUvVersion(bin: UvBin) {
  const args = ["self", "version", "--output-format", "json"];
  const command = Command.make(bin.executable, ...args);
  return command.pipe(
    Command.string,
    Effect.map(Schema.decodeOption(Schema.parseJson(VersionInfo))),
    Effect.catchTags({
      BadArgument: (cause) => new UvExecutionError({ bin, command, cause }),
      SystemError: (cause) => new UvExecutionError({ bin, command, cause }),
    }),
  );
}

/**
 * Handles UvNotInstalledError by showing a modal dialog with options.
 * Dies after user interaction to prevent extension from continuing without UV.
 */
const handleUvNotInstalled = Effect.fn("handleUvNotInstalled")(function* (
  error: UvExecutionError,
  code: VsCode,
  telemetry: Telemetry,
) {
  yield* telemetry.capture("uv_missing", { binType: error.bin._tag });

  const errorMessage = UvBin.$match(error.bin, {
    Bundled: (bin) =>
      `The marimo extension requires uv.\n\nThe bundled binary "${bin.executable}" failed to execute.`,
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
      : UvBin.$is("Bundled")(error.bin)
        ? (["Open Settings"] as const)
        : (["Install uv", "Open Settings"] as const),
  });

  if (Option.isSome(choice) && choice.value === "Install uv") {
    yield* telemetry.capture("uv_install_clicked");

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
