import type * as py from "@vscode/python-extension";

import { Either } from "effect";

import type { VsCode } from "../services/VsCode.ts";

/**
 * Format a {@link py.Environment} similar to vscode-jupyter
 *
 * E.g. "EnvName (Python 3.10.2)" or just "Python 3.10.2"
 */
export function formatControllerLabel(
  code: VsCode,
  env: py.Environment,
): string {
  const versionString = formatPythonVersion(env);
  const envName = resolvePythonEnvironmentName(code, env);

  if (envName) {
    return `${envName} (${versionString})`;
  }
  return versionString;
}

/**
 * Format just the Python version from an environment
 *
 * E.g. "Python 3.10.2" or "Python"
 */
export function formatPythonVersion(env: py.Environment): string {
  const versionParts: Array<number> = [];
  if (env.version) {
    if (typeof env.version.major === "number") {
      versionParts.push(env.version.major);
      if (typeof env.version.minor === "number") {
        versionParts.push(env.version.minor);
        if (typeof env.version.micro === "number") {
          versionParts.push(env.version.micro);
        }
      }
    }
  }
  return versionParts.length > 0
    ? `Python ${versionParts.join(".")}`
    : "Python";
}

/**
 * Format a compact status bar label for a Python environment
 *
 * E.g. "3.10.2 (myenv)" or "3.11.5"
 */
export function formatPythonStatusBarLabel(
  code: VsCode,
  env: py.Environment,
): string {
  const versionParts: Array<number> = [];
  if (env.version) {
    if (typeof env.version.major === "number") {
      versionParts.push(env.version.major);
      if (typeof env.version.minor === "number") {
        versionParts.push(env.version.minor);
        if (typeof env.version.micro === "number") {
          versionParts.push(env.version.micro);
        }
      }
    }
  }
  const versionString =
    versionParts.length > 0 ? versionParts.join(".") : "Python";

  // Check if there's a named environment
  const envName = resolvePythonEnvironmentName(code, env);
  if (envName) {
    return `${versionString} (${envName})`;
  }

  return versionString;
}

/**
 * A human readable name for a {@link py.Environment}
 */
function resolvePythonEnvironmentName(
  code: VsCode,
  env: py.Environment,
): string | undefined {
  if (env.environment?.name) {
    return env.environment.name;
  }
  if (env.environment?.folderUri) {
    return code.utils
      .parseUri(env.environment.folderUri.toString())
      .pipe(Either.getOrThrow)
      .path.split("/")
      .pop();
  }
  return undefined;
}
