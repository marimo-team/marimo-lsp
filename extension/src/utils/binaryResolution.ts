import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

import * as semver from "@std/semver";
import { Data, Effect, Option } from "effect";
import type * as vscode from "vscode";

import { resolvePlatformBinaryName } from "../services/Uv.ts";

/**
 * Runs `<binary> --version` and parses the version string.
 * Expected output format: `<name> <version>`, e.g. `ruff 0.15.0` or `ty 0.0.15`.
 * Returns Option.none() if the version cannot be parsed.
 */
export function getBinaryVersion(
  binaryPath: string,
): Effect.Effect<Option.Option<semver.SemVer>> {
  return Effect.try(() =>
    NodeChildProcess.execFileSync(binaryPath, ["--version"], {
      encoding: "utf8",
      timeout: 10_000,
    }),
  ).pipe(
    Effect.map((output) => {
      const version = parseVersionOutput(output);
      if (version === null) {
        return Option.none<semver.SemVer>();
      }
      return Option.fromNullable(semver.tryParse(version));
    }),
    Effect.catchAll(() => Effect.succeed(Option.none<semver.SemVer>())),
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
 * Check if `actual` is >= `minimum` using semver comparison.
 */
export function isVersionAtLeast(
  actual: semver.SemVer,
  minimum: string,
): boolean {
  const min = semver.tryParse(minimum);
  if (min == null) {
    return false;
  }
  return semver.greaterOrEqual(actual, min);
}

/**
 * Validate that a binary exists at the given path, is executable,
 * and meets the minimum version requirement.
 *
 * Returns the binary path if valid, Option.none() otherwise.
 */
export function validateBinary(
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

    if (!isVersionAtLeast(versionOption.value, minimumVersion)) {
      yield* Effect.logWarning(
        `Binary at ${binaryPath} has version ${semver.format(versionOption.value)}, minimum required is ${minimumVersion}`,
      );
      return Option.none<string>();
    }

    yield* Effect.logInfo(
      `Validated binary at ${binaryPath} (version ${semver.format(versionOption.value)})`,
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
 * - `UserConfigured` — explicit path from `marimo.ruff.path` / `marimo.ty.path`
 * - `CompanionExtension` — discovered via a companion VS Code extension
 *   (either its configured `path` setting or its bundled binary)
 * - `UvInstalled` — installed on-demand via `uv pip install`
 */
export const BinarySource = Data.taggedEnum<BinarySource>();
export type BinarySource = Data.TaggedEnum<{
  UserConfigured: { readonly path: string };
  CompanionExtension: {
    readonly extensionId: string;
    readonly path: string;
    readonly kind: "configured" | "bundled";
  };
  UvInstalled: { readonly path: string };
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
 * Try each source in order. Returns the first successful resolution,
 * or falls through to the fallback. All attempts are logged with
 * structured annotations for the server name.
 */
export function resolveBinary<E, R>(
  serverName: string,
  sources: ReadonlyArray<ResolutionSource<never, R>>,
  fallback: ResolutionSource<E, R>,
): Effect.Effect<BinarySource, E, R> {
  return Effect.gen(function* () {
    for (const source of sources) {
      yield* Effect.logDebug(`Trying resolution source: ${source.label}`).pipe(
        Effect.annotateLogs({ server: serverName, source: source.label }),
      );

      const result = yield* source.resolve;

      if (Option.isSome(result)) {
        yield* Effect.logInfo("Resolved binary").pipe(
          Effect.annotateLogs({
            server: serverName,
            source: result.value._tag,
            path: result.value.path,
          }),
        );
        return result.value;
      }

      yield* Effect.logDebug(
        "Source did not resolve a binary, trying next",
      ).pipe(Effect.annotateLogs({ server: serverName, source: source.label }));
    }

    yield* Effect.logInfo(
      `No source resolved a binary, using fallback: ${fallback.label}`,
    ).pipe(Effect.annotateLogs({ server: serverName, source: fallback.label }));

    const result = yield* fallback.resolve;
    if (Option.isNone(result)) {
      return yield* Effect.die(
        new Error(
          `Fallback source "${fallback.label}" failed to resolve a ${serverName} binary`,
        ),
      );
    }

    yield* Effect.logInfo("Resolved binary").pipe(
      Effect.annotateLogs({
        server: serverName,
        source: result.value._tag,
        path: result.value.path,
      }),
    );
    return result.value;
  });
}

// ---------------------------------------------------------------------------
// Reusable resolution sources
// ---------------------------------------------------------------------------

/**
 * Tier 1: Resolve from a user-configured path setting (e.g. `marimo.ruff.path`).
 */
export function userConfiguredPath(
  binaryName: string,
  minimumVersion: string,
  getPath: Effect.Effect<Option.Option<string>>,
): ResolutionSource {
  return {
    label: `user-configured (marimo.${binaryName}.path)`,
    resolve: Effect.gen(function* () {
      const userPath = yield* getPath;
      if (Option.isNone(userPath)) {
        return Option.none();
      }
      const validated = yield* validateBinary(userPath.value, minimumVersion);
      if (Option.isNone(validated)) {
        yield* Effect.logWarning(
          `User-configured path "${userPath.value}" is invalid or does not meet minimum version ${minimumVersion}`,
        ).pipe(
          Effect.annotateLogs({
            server: binaryName,
            path: userPath.value,
            minimumVersion,
          }),
        );
        return Option.none();
      }
      return Option.some(
        BinarySource.UserConfigured({ path: validated.value }),
      );
    }),
  };
}

/**
 * Tier 2a: Resolve from a companion extension's configured path setting.
 *
 * Some extensions store their path as a `string` (ruff), others as `string[]` (ty).
 * The caller normalizes to `Option<string>`.
 */
export function companionExtensionConfiguredPath<R>(
  binaryName: string,
  minimumVersion: string,
  extensionId: string,
  getConfiguredPath: Effect.Effect<Option.Option<string>, never, R>,
): ResolutionSource<never, R> {
  return {
    label: `companion extension setting (${extensionId})`,
    resolve: Effect.gen(function* () {
      const configuredPath = yield* getConfiguredPath;
      if (Option.isNone(configuredPath)) {
        return Option.none();
      }
      const validated = yield* validateBinary(
        configuredPath.value,
        minimumVersion,
      );
      if (Option.isNone(validated)) {
        yield* Effect.logWarning(
          `Companion extension path "${configuredPath.value}" is invalid or does not meet minimum version ${minimumVersion}`,
        ).pipe(
          Effect.annotateLogs({
            server: binaryName,
            extensionId,
            path: configuredPath.value,
            minimumVersion,
          }),
        );
        return Option.none();
      }
      return Option.some(
        BinarySource.CompanionExtension({
          extensionId,
          path: validated.value,
          kind: "configured",
        }),
      );
    }),
  };
}

/**
 * Tier 2b: Resolve from a companion extension's bundled binary.
 *
 * Looks for the binary at `<extensionPath>/bundled/libs/bin/<binary>`.
 */
export function companionExtensionBundledBinary(
  binaryName: string,
  minimumVersion: string,
  extensionId: string,
  extension: Option.Option<vscode.Extension<unknown>>,
): ResolutionSource {
  return {
    label: `companion extension bundled binary (${extensionId})`,
    resolve: Effect.gen(function* () {
      if (Option.isNone(extension)) {
        yield* Effect.logDebug(
          `Companion extension ${extensionId} is not installed`,
        );
        return Option.none();
      }
      const bundledPath = NodePath.join(
        extension.value.extensionPath,
        "bundled",
        "libs",
        "bin",
        resolvePlatformBinaryName(binaryName as "ruff" | "ty"),
      );
      const validated = yield* validateBinary(bundledPath, minimumVersion);
      if (Option.isNone(validated)) {
        return Option.none();
      }
      return Option.some(
        BinarySource.CompanionExtension({
          extensionId,
          path: validated.value,
          kind: "bundled",
        }),
      );
    }),
  };
}
