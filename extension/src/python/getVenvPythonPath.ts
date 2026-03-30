import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

/**
 * Returns the path to the Python executable within a virtual environment.
 * Handles platform differences:
 * - Windows: .venv/Scripts/python.exe
 * - Unix: .venv/bin/python
 */
export function getVenvPythonPath(venvPath: string): string {
  return NodeProcess.platform === "win32"
    ? NodePath.join(venvPath, "Scripts", "python.exe")
    : NodePath.join(venvPath, "bin", "python");
}
