import { Option } from "effect";
import * as NodeFs from "node:fs";
import * as NodePath from "node:path";

/**
 * Resolves a path to a virtual environment directory.
 *
 * VS Code typically represents Python environments by their executable path
 * (e.g., `.venv/bin/python` or `.venv/Scripts/python.exe`), but we need the
 * actual virtual environment directory (e.g., `.venv`) for package installation.
 *
 * If the target is a Python executable, looks two directories up for `pyvenv.cfg`
 * to locate the venv root. Otherwise, checks if the target itself is a venv by
 * looking for `pyvenv.cfg` in that directory.
 *
 * @param target - Path to check (either a Python executable or directory)
 * @returns Some(venv_path) if a valid venv is found, None otherwise
 */
export function findVenvPath(target: string): Option.Option<string> {
  const basename = NodePath.basename(target);

  const isPythonExecutable =
    basename === "python" ||
    basename.startsWith("python3") ||
    basename === "python.exe" ||
    basename.startsWith("python3.") ||
    basename === "python3.exe";

  const candidate = isPythonExecutable
    ? // Look two directories up (e.g., .venv/bin/python -> .venv)
      NodePath.resolve(target, "..", "..")
    : // Otherwise check the target itself
      target;

  return NodeFs.existsSync(NodePath.join(candidate, "pyvenv.cfg"))
    ? Option.some(candidate)
    : Option.none();
}
