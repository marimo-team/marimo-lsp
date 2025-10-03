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
  const formatted =
    versionParts.length > 0 ? `Python ${versionParts.join(".")}` : "Python";

  // Format similar to vscode-jupyter: "EnvName (Python 3.10.2)" or just "Python 3.10.2"
  const envName = resolvePythonEnvironmentName(code, env);
  if (envName) {
    return `${envName} (${formatted})`;
  }
  return formatted;
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
