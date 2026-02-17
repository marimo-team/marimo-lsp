import * as semver from "@std/semver";
import { Effect, Option } from "effect";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";

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
