import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { Data, Effect, Option, Order, Schema } from "effect";

import * as VsCode from "../platform/VsCode.ts";
import * as Uv from "../python/Uv.ts";
import { Version } from "./Version.ts";

/**
 * Runs `<binary> --version` and parses the version string.
 * Expected output format: `<name> <version>`, e.g. `ruff 0.15.0` or `ty 0.0.15`.
 * Returns Option.none() if the version cannot be parsed.
 */
function getBinaryVersion(
  binaryPath: string,
): Effect.Effect<Option.Option<Version>> {
  return Effect.try(() =>
    NodeChildProcess.execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }),
  ).pipe(
    Effect.map((output) => {
      const version = parseVersionOutput(output);
      if (version === null) {
        return Option.none<Version>();
      }
      return Schema.decodeOption(Version.Schema)(version);
    }),
    Effect.catch(() => Effect.succeed(Option.none<Version>())),
  );
}

/**
 * Parse the version string from `<binary> --version` output.
 * Expects format like `ruff 0.15.0` or `ty 0.0.15`.
 */
export function parseVersionOutput(output: string): string | null {
  const match = output.trim().match(/^\S+\s+(\d+\.\d+\.\d+\S*)/);
  return match?.[1] ?? null;
}

/**
 * Validate that a binary exists at the given path, is executable,
 * and meets the minimum version requirement.
 *
 * Returns the binary path if valid, Option.none() otherwise.
 */
function validateBinary(
  binaryPath: string,
  minimumVersion: string,
): Effect.Effect<Option.Option<string>> {
  return Effect.gen(function* () {
    if (!NodeFs.existsSync(binaryPath)) {
      yield* Effect.logDebug(`Binary not found at ${binaryPath}`);
      return Option.none<string>();
    }

    const versionOption = yield* getBinaryVersion(binaryPath);
    if (Option.isNone(versionOption)) {
      yield* Effect.logWarning(
        `Could not determine version for binary at ${binaryPath}`,
      );
      return Option.none<string>();
    }

    const minimum = Schema.decodeOption(Version.Schema)(minimumVersion);
    if (Option.isNone(minimum)) {
      yield* Effect.logWarning(`Invalid minimum version: ${minimumVersion}`);
      return Option.none<string>();
    }

    if (
      !Order.isGreaterThanOrEqualTo(Version.Order)(
        versionOption.value,
        minimum.value,
      )
    ) {
      yield* Effect.logWarning(
        `Binary at ${binaryPath} has version ${versionOption.value.toString()}, minimum required is ${minimumVersion}`,
      );
      return Option.none<string>();
    }

    yield* Effect.logDebug(
      `Validated binary at ${binaryPath} (version ${versionOption.value.toString()})`,
    );
    return Option.some(binaryPath);
  });
}

// ---------------------------------------------------------------------------
// Binary source — describes where a resolved binary came from
// ---------------------------------------------------------------------------

/**
 * Discriminated union representing the source of a resolved language server binary.
 *
 * - `UserConfigured` — explicit path from a `marimo.<server>.path` setting
 * - `CompanionExtension` — discovered via a companion VS Code extension
 *   (either its configured `path` setting or its bundled binary)
 */
export const BinarySource = Data.taggedEnum<BinarySource>();
export type BinarySource = Data.TaggedEnum<{
  UserConfigured: { readonly path: string };
  CompanionExtension: {
    readonly extensionId: string;
    readonly path: string;
    readonly kind: "configured" | "bundled";
  };
}>;

// ---------------------------------------------------------------------------
// Resolution strategy types
// ---------------------------------------------------------------------------

/**
 * A resolution source represents one way to find a binary. Each source
 * is tried in order — the first to return Some wins.
 */
export interface ResolutionSource<E = never, R = never> {
  readonly label: string;
  readonly resolve: Effect.Effect<Option.Option<BinarySource>, E, R>;
}

/**
 * Try each source in order. Returns the first successful resolution, or
 * `Option.none()` when every source comes up empty. All attempts are logged
 * with structured annotations for the server name.
 *
 * There is deliberately no install-on-demand fallback: resolution never
 * reaches the network, so it cannot hang or fail on a blocked package index.
 */
export function resolveBinary<R>(
  serverName: string,
  sources: ReadonlyArray<ResolutionSource<never, R>>,
): Effect.Effect<Option.Option<BinarySource>, never, R> {
  return Effect.gen(function* () {
    for (const source of sources) {
      yield* Effect.logDebug(`Trying resolution source: ${source.label}`).pipe(
        Effect.annotateLogs({ server: serverName, source: source.label }),
      );

      const result = yield* source.resolve;

      if (Option.isSome(result)) {
        yield* Effect.logDebug("Resolved binary").pipe(
          Effect.annotateLogs({
            server: serverName,
            source: result.value._tag,
            path: result.value.path,
          }),
        );
        return result;
      }

      yield* Effect.logDebug(
        "Source did not resolve a binary, trying next",
      ).pipe(Effect.annotateLogs({ server: serverName, source: source.label }));
    }

    yield* Effect.logInfo("No source resolved a binary").pipe(
      Effect.annotateLogs({
        server: serverName,
        sources: sources.map((source) => source.label),
      }),
    );
    return Option.none();
  });
}

/** Binary-discovery details supplied by each language server. */
export interface ServerBinary {
  readonly name: "ruff" | "ty" | "pyrefly";
  readonly minimumVersion: string;
  readonly extensionId: string;
  readonly pathSetting?: string;
  readonly binaryDir?: ReadonlyArray<string>;
}

/**
 * Resolve a marimo override, then companion settings, then the bundled binary.
 * Keep discovery common while callers own server arguments and configuration.
 */
export const resolveServerBinary = Effect.fn(
  "binaryResolution.resolveServerBinary",
)(function* (
  spec: ServerBinary,
  userPath: Effect.Effect<Option.Option<string>>,
) {
  const code = yield* VsCode.Service;
  // There is one managed server for the window. Relative settings use its
  // first workspace folder, or the extension host cwd in an empty window.
  const folders = yield* code.workspace.getWorkspaceFolders;
  const root =
    Option.getOrElse(folders, () => [])[0]?.uri.fsPath ?? process.cwd();
  const configuredPath = Effect.gen(function* () {
    const config = yield* code.workspace.getConfiguration(spec.name);
    return yield* resolveConfiguredPaths(
      config.get<unknown>(spec.pathSetting ?? "path"),
      spec.minimumVersion,
      root,
    );
  });
  const bundledPath = Effect.gen(function* () {
    const extension = code.extensions.getExtension(spec.extensionId);
    if (Option.isNone(extension)) return Option.none<string>();
    return yield* validateBinary(
      NodePath.join(
        extension.value.extensionPath,
        ...(spec.binaryDir ?? ["bundled", "libs", "bin"]),
        Uv.resolvePlatformBinaryName(spec.name),
      ),
      spec.minimumVersion,
    );
  });
  const companion = (path: string, kind: "configured" | "bundled") =>
    BinarySource.CompanionExtension({
      extensionId: spec.extensionId,
      path,
      kind,
    });

  return yield* resolveBinary(spec.name, [
    {
      label: `user-configured (marimo.${spec.name}.path)`,
      resolve: userPath.pipe(
        Effect.flatMap((path) =>
          resolveConfiguredPaths(
            Option.getOrUndefined(path),
            spec.minimumVersion,
            root,
          ),
        ),
        Effect.map(Option.map((path) => BinarySource.UserConfigured({ path }))),
      ),
    },
    {
      label: `companion extension setting (${spec.extensionId})`,
      resolve: configuredPath.pipe(
        Effect.map(Option.map((path) => companion(path, "configured"))),
      ),
    },
    {
      label: `companion extension bundled binary (${spec.extensionId})`,
      resolve: bundledPath.pipe(
        Effect.map(Option.map((path) => companion(path, "bundled"))),
      ),
    },
  ]);
});

const resolveConfiguredPaths = Effect.fnUntraced(function* (
  value: unknown,
  minimumVersion: string,
  root: string,
) {
  const paths = Array.isArray(value) ? value : [value];
  for (const path of paths) {
    if (typeof path !== "string" || path.length === 0) continue;
    for (const candidate of configuredPathCandidates(path, root)) {
      const validated = yield* validateBinary(candidate, minimumVersion);
      if (Option.isSome(validated)) return validated;
    }
    yield* Effect.logWarning(
      "Configured binary is invalid or does not meet the minimum version",
    ).pipe(Effect.annotateLogs({ path, minimumVersion }));
  }
  return Option.none<string>();
});

/** Expand paths before validation; bare names also search PATH without a shell. */
function configuredPathCandidates(value: string, root: string): string[] {
  if (
    value === "~" ||
    value.startsWith("~/") ||
    (process.platform === "win32" && value.startsWith("~\\"))
  ) {
    return executableNames(NodePath.join(NodeOs.homedir(), value.slice(2)));
  }
  if (
    NodePath.isAbsolute(value) ||
    value.includes("/") ||
    (process.platform === "win32" && value.includes("\\"))
  ) {
    return executableNames(NodePath.resolve(root, value));
  }

  const names = executableNames(value);
  const directories = [
    root,
    ...(process.env.PATH?.split(NodePath.delimiter) ?? []),
  ];
  return directories.flatMap((directory) =>
    names.map((name) =>
      NodePath.resolve(directory.replace(/^"(.*)"$/, "$1"), name),
    ),
  );
}

function executableNames(path: string): string[] {
  if (process.platform !== "win32") return [path];
  const extensions = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter(Boolean);
  if (
    extensions.some((ext) => path.toLowerCase().endsWith(ext.toLowerCase()))
  ) {
    return [path];
  }
  return [path, ...extensions.map((ext) => path + ext)];
}
