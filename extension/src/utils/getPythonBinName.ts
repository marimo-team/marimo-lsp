import * as NodeProcess from "node:process";

export function getPythonBinName() {
  return NodeProcess.platform === "win32" ? "python.exe" : "python";
}
