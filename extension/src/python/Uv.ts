import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { NodeServices } from "@effect/platform-node";
import {
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Order,
  Schema,
  Scope,
  Stream,
  String,
} from "effect";
import type { PlatformError } from "effect/PlatformError";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import type * as vscode from "vscode";

import { Config } from "../config/Config.ts";
import { Version } from "../lib/Version.ts";
import { VsCode } from "../platform/VsCode.ts";
import { Telemetry } from "../telemetry/Telemetry.ts";
import { getVenvPythonPath } from "./getVenvPythonPath.ts";
import type { ProjectDependencyTarget } from "./ProjectDependencyTarget.ts";

export const MINIMUM_UV_VERSION = Version.make("0.12.0");

export interface UvPackage {
  readonly name: string;
  readonly version: string;
}

export interface UvSyncHandle {
  readonly environment: string;
  readonly executable: string;
}

export const UvBin = Data.taggedEnum<UvBin>();
export type UvBin = Data.TaggedEnum<{
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
  resolvePlatformBinaryName("uv"),
);

export class UvExecutionError extends Data.TaggedError("UvExecutionError")<{
  bin: UvBin;
  command: ChildProcess.Command;
  cause: PlatformError;
}> {}

export class UvUnknownError extends Data.TaggedError("UvUnknownError")<{
  command: ChildProcess.Command;
  exitCode?: ChildProcessSpawner.ExitCode;
  stderr: string;
}> {}

export class UvOutputDecodeError extends Data.TaggedError(
  "UvOutputDecodeError",
)<{
  readonly command: "sync" | "tree";
  readonly cause: unknown;
}> {
  override readonly message = `Unable to decode uv ${this.command} JSON output`;
}

export class UvUnsupportedVersionError extends Data.TaggedError(
  "UvUnsupportedVersionError",
)<{
  readonly bin: UvBin;
  readonly detectedVersion: string | null;
  readonly minimumVersion: string;
}> {
  override readonly message =
    this.detectedVersion === null
      ? `Unable to determine uv version; uv ${this.minimumVersion} or newer is required`
      : `uv ${this.detectedVersion} is unsupported; uv ${this.minimumVersion} or newer is required`;
}

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

type LanguageServerInstallStrategy = "default" | "native-tls" | "offline";

type LanguageServerInstallAttempt = {
  readonly strategy: LanguageServerInstallStrategy;
  readonly error: UvUnknownError | UvExecutionError;
};

export type InstallPolicy = {
  readonly initial: LanguageServerInstallStrategy;
  readonly next: (
    current: LanguageServerInstallStrategy,
    error: UvUnknownError,
  ) => Option.Option<LanguageServerInstallStrategy>;
};

const InstallStrategy = {
  /**
   * Predicates that match stderr patterns to determine if a retry strategy
   * might help. These check for known error messages from uv that indicate
   * specific failure modes (TLS issues, network failures, etc.).
   */
  should: {
    retryWithNativeTls(error: UvUnknownError): boolean {
      return (
        error.stderr.includes("invalid peer certificate") ||
        error.stderr.includes("--native-tls")
      );
    },
    retryOffline(error: UvUnknownError): boolean {
      return error.stderr.includes("Request failed after");
    },
  },

  next(
    current: LanguageServerInstallStrategy,
    error: UvUnknownError,
  ): Option.Option<LanguageServerInstallStrategy> {
    if (current === "default" && this.should.retryWithNativeTls(error)) {
      return Option.some("native-tls");
    }
    if (current !== "offline" && this.should.retryOffline(error)) {
      return Option.some("offline");
    }
    return Option.none();
  },
};

export class LanguageServerInstallError extends Data.TaggedError(
  "LanguageServerInstallError",
)<{
  readonly server: { name: "ruff" | "ty"; version: string };
  readonly targetPath: string;
  readonly attempts: ReadonlyArray<LanguageServerInstallAttempt>;
}> {
  override readonly message = this.format();

  format(): string {
    const lines = [
      `Failed to install ${this.server.name}@${this.server.version}`,
      `Target: ${this.targetPath}`,
    ];
    for (const attempt of this.attempts) {
      const errorMsg =
        attempt.error._tag === "UvExecutionError"
          ? `execution error: ${attempt.error.cause.message}`
          : `exit code ${attempt.error.exitCode ?? "unknown"}: ${attempt.error.stderr.slice(0, 200)}`;
      lines.push(`  [${attempt.strategy}] ${errorMsg}`);
    }
    return lines.join("\n");
  }
}

export class Uv extends Context.Service<Uv>()("Uv", {
  make: Effect.gen(function* () {
    const code = yield* VsCode;
    const config = yield* Config;
    const telemetry = yield* Telemetry;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const scope = yield* Effect.scope;
    const channel = yield* code.window.createOutputChannel("marimo (uv)");

    // Resolve uv on first use. WASM language-server startup does not need uv,
    // and the universal extension intentionally does not bundle the binary.
    const discoveredUvBinary = yield* Effect.cached(
      findUvBin(yield* config.uv.path).pipe(
        Effect.provideService(VsCode, code),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    const supportedUvBinary = Effect.flatMap(
      discoveredUvBinary,
      requireSupportedUvBin,
    );

    const uvBinary = yield* Effect.cached(
      Effect.gen(function* () {
        const bin = yield* supportedUvBinary.pipe(
          Effect.catchTags({
            UvExecutionError: (error) =>
              handleUvNotInstalled(error, code, telemetry),
            UvUnsupportedVersionError: (error) =>
              handleUvUnsupportedVersion(error, code, telemetry),
          }),
        );

        const version = Option.match(bin.version, {
          onSome: (value) => value.version.toString(),
          onNone: () => "unknown",
        });
        yield* telemetry.binaryResolved({
          server: "uv",
          source: bin._tag,
          version,
        });
        return bin;
      }).pipe(
        Effect.provideService(VsCode, code),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(Scope.Scope, scope),
      ),
    );

    const uv = (options: Parameters<ReturnType<typeof createUv>>[0]) =>
      Effect.flatMap(uvBinary, (bin) =>
        createUv(bin, spawner, channel)(options),
      );

    return {
      bin: uvBinary,
      getCacheDirOption: supportedUvBinary.pipe(
        Effect.flatMap((bin) =>
          createUv(bin, spawner, channel)({ args: ["cache", "dir"] }),
        ),
        Effect.map(({ stdout }) => stdout.trim()),
        Effect.tapError((cause) =>
          Effect.logDebug("uv cache directory is unavailable").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
        Effect.option,
      ),
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
          args: [
            "tree",
            "--script",
            options.script,
            "-d",
            "0",
            "--quiet",
            "--format",
            "json",
          ],
        }).pipe(
          Effect.catchTag(
            "UvUnknownError",
            UvResolutionError.refine.bind(null),
          ),
          Effect.catchTag(
            "UvUnknownError",
            UvMissingPep723MetadataError.refine.bind(null, options.script),
          ),
          Effect.flatMap(({ stdout }) => decodeUvTreeOutput(stdout)),
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
        return uv({
          args: ["sync", "--script", options.script, "--output-format", "json"],
        }).pipe(
          Effect.flatMap(({ stdout }) => decodeUvSyncOutput(stdout)),
          Effect.catchTag(
            "UvUnknownError",
            UvMissingPep723MetadataError.refine.bind(null, options.script),
          ),
          Effect.catchTag(
            "UvUnknownError",
            UvResolutionError.refine.bind(null),
          ),
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
        target?: ProjectDependencyTarget;
      }) {
        const args = ["add"];
        switch (options.target?._tag) {
          case "Group":
            args.push("--group", options.target.name);
            break;
          case "Optional":
            args.push("--optional", options.target.name);
            break;
        }
        args.push(...options.packages, "--directory", options.directory);
        return uv({ args }).pipe(
          Effect.catchTag(
            "UvUnknownError",
            UvResolutionError.refine.bind(null),
          ),
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
        const args = ["pip", "install"];
        return Effect.andThen(
          uv({
            args: [...args, ...packages],
            env: {
              VIRTUAL_ENV: options.venv,
            },
          }),
          Effect.void,
        );
      },
      ensureLanguageServerBinaryInstalled(
        server: {
          name: "ruff" | "ty";
          version: string;
        },
        options: {
          targetPath: string;
          policy?: InstallPolicy;
        },
      ) {
        const policy: InstallPolicy = options.policy ?? {
          initial: "default",
          next: InstallStrategy.next.bind(InstallStrategy),
        };

        const strategyToEnv = {
          default: {},
          "native-tls": { UV_NATIVE_TLS: "1" },
          offline: { UV_OFFLINE: "1" },
        } as const;

        const tryInstall = (strategy: LanguageServerInstallStrategy) =>
          uv({
            args: [
              "pip",
              "install",
              "--target",
              options.targetPath,
              "--no-deps",
              `${server.name}==${server.version}`,
            ],
            env: {
              UV_NO_CONFIG: "1",
              // We don't want to set UV_PYTHON here so it can find any valid python version
              // otherwise it will fail when the user has a different python version installed.
              // UV_PYTHON: "3.10",
              UV_DEFAULT_INDEX: "https://pypi.org/simple/",
              ...strategyToEnv[strategy],
            },
            // Set cwd to the OS temp directory so uv doesn't walk up parent
            // directories and discover a broken .venv (e.g., wrong-arch
            // python.exe on Windows → OS error 193).
            cwd: NodeOs.tmpdir(),
          });

        const loop = (
          attempts: ReadonlyArray<LanguageServerInstallAttempt>,
          strategy: LanguageServerInstallStrategy,
        ): Effect.Effect<string, LanguageServerInstallError> =>
          Effect.gen(function* () {
            yield* Effect.logDebug(
              `Installing ${server.name}@${server.version} with strategy="${strategy}"`,
            );
            return yield* tryInstall(strategy).pipe(
              Effect.catchTag("UvUnknownError", (error) => {
                const newAttempts = [...attempts, { strategy, error }];
                return Option.match(policy.next(strategy, error), {
                  onSome: (next) =>
                    Effect.andThen(
                      Effect.logDebug(
                        `Strategy "${strategy}" failed, retrying with "${next}"`,
                      ),
                      loop(newAttempts, next),
                    ),
                  onNone: () =>
                    Effect.andThen(
                      Effect.logDebug(
                        `Strategy "${strategy}" failed, no more strategies to try`,
                      ),
                      new LanguageServerInstallError({
                        server,
                        targetPath: options.targetPath,
                        attempts: newAttempts,
                      }),
                    ),
                });
              }),
              Effect.catchTag(
                "UvExecutionError",
                (error) =>
                  new LanguageServerInstallError({
                    server,
                    targetPath: options.targetPath,
                    attempts: [...attempts, { strategy, error }],
                  }),
              ),
              Effect.map(() =>
                NodePath.resolve(
                  options.targetPath,
                  "bin",
                  resolvePlatformBinaryName(server.name),
                ),
              ),
            );
          });

        return loop([], policy.initial);
      },
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([NodeServices.layer, Config.layer]),
  );
}

function createUv(
  bin: UvBin,
  spawner: Context.Service.Shape<
    typeof ChildProcessSpawner.ChildProcessSpawner
  >,
  channel: vscode.OutputChannel,
) {
  return Effect.fn("uv")(function* (options: {
    readonly args: ReadonlyArray<string>;
    readonly env?: Record<string, string>;
    readonly cwd?: string;
  }) {
    // `extendEnv: true` gives the parent environment to the child. The env
    // vars of the command are merged into it.
    const command = ChildProcess.make(bin.executable, options.args, {
      env: { NO_COLOR: "1", ...options.env },
      extendEnv: true,
      cwd: options.cwd,
    });
    yield* Effect.annotateCurrentSpan("args", options.args);
    const [exitCode, stdout, stderr] = yield* command.pipe(
      Effect.flatMap((handle) =>
        Effect.all(
          [
            // Waits for the process to exit and returns
            // the ExitCode of the command that was run
            handle.exitCode,
            runString(handle.stdout, channel),
            runString(handle.stderr, channel),
          ],
          { concurrency: 3 },
        ),
      ),
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.catchTag(
        "PlatformError",
        (cause) => new UvExecutionError({ bin, command, cause }),
      ),
    );
    if (exitCode !== 0) {
      return yield* new UvUnknownError({ command, exitCode, stderr });
    }
    return { stdout, stderr };
  });
}

const UvOutputSchemaVersion = Schema.Struct({ version: Schema.String });

const UvSyncOutput = Schema.Struct({
  schema: UvOutputSchemaVersion,
  sync: Schema.Struct({
    environment: Schema.Struct({
      path: Schema.String,
      python: Schema.Struct({ path: Schema.String }),
    }),
  }),
});

const UvTreeNode = Schema.Struct({
  kind: Schema.String,
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  dependencies: Schema.Array(Schema.Struct({ id: Schema.String })),
});

const UvTreeOutput = Schema.Struct({
  schema: UvOutputSchemaVersion,
  script: Schema.Struct({ id: Schema.String }),
  resolution: Schema.Record(Schema.String, UvTreeNode),
});

export const decodeUvSyncOutput = Effect.fn("decodeUvSyncOutput")(function* (
  stdout: string,
): Effect.fn.Return<UvSyncHandle, UvOutputDecodeError> {
  const output = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(UvSyncOutput),
  )(stdout).pipe(
    Effect.mapError(
      (cause) => new UvOutputDecodeError({ command: "sync", cause }),
    ),
  );
  const environment = NodePath.resolve(output.sync.environment.path);
  const canonicalExecutable = getVenvPythonPath(environment);
  const executable = NodeFs.existsSync(canonicalExecutable)
    ? canonicalExecutable
    : NodePath.resolve(output.sync.environment.python.path);
  return { environment, executable };
});

export const decodeUvTreeOutput = Effect.fn("decodeUvTreeOutput")(function* (
  stdout: string,
): Effect.fn.Return<ReadonlyArray<UvPackage>, UvOutputDecodeError> {
  const output = yield* Schema.decodeUnknownEffect(
    Schema.fromJsonString(UvTreeOutput),
  )(stdout).pipe(
    Effect.mapError(
      (cause) => new UvOutputDecodeError({ command: "tree", cause }),
    ),
  );
  const scriptNode = output.resolution[output.script.id];
  if (scriptNode?.kind !== "script") {
    return yield* new UvOutputDecodeError({
      command: "tree",
      cause: new Error("The script resolution node is missing"),
    });
  }

  return yield* Effect.forEach(scriptNode.dependencies, ({ id }) => {
    const dependency = output.resolution[id];
    if (
      dependency?.kind !== "package" ||
      dependency.name === undefined ||
      dependency.version === undefined
    ) {
      return new UvOutputDecodeError({
        command: "tree",
        cause: new Error(`Package resolution node ${id} is missing`),
      });
    }
    return Effect.succeed({
      name: dependency.name,
      version: dependency.version,
    });
  });
});

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
    Stream.runFold(() => String.empty, String.concat),
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
    bin = UvBin.Bundled({
      executable: BUNDLED_UV_PATH,
      version: Option.none(),
    });
  }
  // Priority 2: User-configured path
  else if (Option.isSome(userConfigPath)) {
    bin = UvBin.Configured({
      executable: userConfigPath.value,
      version: Option.none(),
    });
  }
  // Priority 3: Bundled binary
  else if (bundledExists) {
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
        Effect.catch(() => Effect.succeed(false)),
      );
      if (exists) {
        found = UvBin.Discovered({
          executable: path,
          version: Option.none(),
        });
        break;
      }
    }

    bin =
      found ?? UvBin.Default({ executable: binName, version: Option.none() });
  }

  // Validate that the binary actually works
  const version = yield* getUvVersion(bin);

  if (Option.isNone(version)) {
    yield* Effect.logWarning("Unable to parse uv version");
  }

  const versionStr = Option.match(version, {
    onSome: (v) => v.format(),
    onNone: () => "unknown",
  });

  // Single wide event with all context
  yield* Effect.logInfo(
    `Using ${bin._tag.toLowerCase()} uv: ${bin.executable} ${versionStr}`,
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
  version: Version.Schema,
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
    const version = this.version.toString();
    if (!this.commit_info) {
      return version;
    }
    return `${version} (${this.commit_info.short_commit_hash} ${this.commit_info.commit_date})`;
  }
}

const requireSupportedUvBin = Effect.fn("requireSupportedUvBin")(function* (
  bin: UvBin,
) {
  const detectedVersion = Option.match(bin.version, {
    onSome: ({ version }) => version.toString(),
    onNone: () => null,
  });
  const supported = Option.exists(bin.version, ({ version }) =>
    Order.isGreaterThanOrEqualTo(Version.Order)(version, MINIMUM_UV_VERSION),
  );
  if (!supported) {
    return yield* new UvUnsupportedVersionError({
      bin,
      detectedVersion,
      minimumVersion: MINIMUM_UV_VERSION.toString(),
    });
  }
  return bin;
});

const getUvVersion = Effect.fn("getUvVersion")(function* (bin: UvBin) {
  const args = ["self", "version", "--output-format", "json"];
  const command = ChildProcess.make(bin.executable, args);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner.string(command).pipe(
    Effect.map(Schema.decodeOption(Schema.fromJsonString(VersionInfo))),
    Effect.catchTag(
      "PlatformError",
      (cause) => new UvExecutionError({ bin, command, cause }),
    ),
  );
});

/**
 * Handles UvNotInstalledError by showing a modal dialog with options.
 * Dies after user interaction to prevent extension from continuing without UV.
 */
const handleUvNotInstalled = Effect.fn("handleUvNotInstalled")(function* (
  error: UvExecutionError,
  code: Context.Service.Shape<typeof VsCode>,
  telemetry: Context.Service.Shape<typeof Telemetry>,
) {
  yield* telemetry.uvMissing(error.bin._tag);

  const errorMessage = UvBin.$match(error.bin, {
    Bundled: (bin) =>
      `The marimo extension requires uv.\n\nThe bundled binary "${bin.executable}" failed to execute.`,
    Configured: (bin) =>
      `The marimo extension requires uv.\n\nThe configured path "${bin.executable}" was not found.`,
    Default: () => "The marimo extension requires uv.",
    Discovered: (bin) =>
      `The marimo extension requires uv.\n\nFound "${bin.executable}" but it failed to execute.`,
  });

  yield* promptForUvSetup({
    errorMessage,
    installAction:
      UvBin.$is("Configured")(error.bin) || UvBin.$is("Bundled")(error.bin)
        ? null
        : "Install uv",
    reloadMessage:
      "After installing uv, reload the window to activate the marimo extension.",
    code,
    telemetry,
  });

  // Die to prevent extension from continuing without UV
  return yield* Effect.die(error);
});

const handleUvUnsupportedVersion = Effect.fn("handleUvUnsupportedVersion")(
  function* (
    error: UvUnsupportedVersionError,
    code: Context.Service.Shape<typeof VsCode>,
    telemetry: Context.Service.Shape<typeof Telemetry>,
  ) {
    const detected =
      error.detectedVersion === null
        ? "Its version could not be determined."
        : `Found version ${error.detectedVersion}.`;
    const errorMessage = `marimo's uv-backed features require uv ${error.minimumVersion} or newer.\n\n${detected}\n\nExecutable: "${error.bin.executable}"`;
    yield* promptForUvSetup({
      errorMessage,
      installAction:
        UvBin.$is("Default")(error.bin) || UvBin.$is("Discovered")(error.bin)
          ? "Update uv"
          : null,
      reloadMessage:
        "After updating uv, reload the window to activate uv-backed features.",
      code,
      telemetry,
    });

    return yield* Effect.die(error);
  },
);

const promptForUvSetup = Effect.fn("promptForUvSetup")(function* (options: {
  readonly errorMessage: string;
  readonly installAction: "Install uv" | "Update uv" | null;
  readonly reloadMessage: string;
  readonly code: Context.Service.Shape<typeof VsCode>;
  readonly telemetry: Context.Service.Shape<typeof Telemetry>;
}) {
  const choice = yield* options.code.window.showErrorMessage(
    options.errorMessage,
    {
      modal: true,
      items:
        options.installAction === null
          ? (["Open Settings"] as const)
          : ([options.installAction, "Open Settings"] as const),
    },
  );

  if (
    Option.isSome(choice) &&
    options.installAction !== null &&
    choice.value === options.installAction
  ) {
    yield* options.telemetry.uvInstallClicked;
    // Keep the terminal hidden from Python environment auto-discovery until
    // the user accepts the command.
    const terminal = yield* options.code.window.createTerminal({
      name: options.installAction,
      hideFromUser: true,
    });
    terminal.sendText(
      NodeProcess.platform === "win32"
        ? 'powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"'
        : "curl -LsSf https://astral.sh/uv/install.sh | sh",
      false,
    );
    terminal.show();

    const reload = yield* options.code.window.showInformationMessage(
      options.reloadMessage,
      { items: ["Reload Window"] },
    );
    if (Option.isSome(reload) && reload.value === "Reload Window") {
      yield* options.code.commands.executeVSCode(
        "workbench.action.reloadWindow",
      );
    }
  }

  if (Option.isSome(choice) && choice.value === "Open Settings") {
    yield* options.code.commands.executeVSCode(
      "workbench.action.openSettings",
      "marimo.uv.path",
    );
  }
});

export function resolvePlatformBinaryName(name: "uv" | "ruff" | "ty") {
  return NodeProcess.platform === "win32" ? `${name}.exe` : name;
}
