import * as NodeFs from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import type { loadPyodide as LoadPyodide } from "pyodide";
import { StreamMessageReader, StreamMessageWriter } from "vscode-jsonrpc/node";

interface PyodideModule {
  readonly loadPyodide: typeof LoadPyodide;
}

interface WasmBridge {
  readonly handle_message: (messageJson: string) => Promise<void>;
  readonly close: () => void;
  readonly destroy: () => void;
}

interface WasmModule {
  readonly create_bridge: (
    writeMessage: (messageJson: string) => void,
    processes: object,
  ) => WasmBridge;
  readonly destroy: () => void;
}

function isPyodideModule(value: unknown): value is PyodideModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "loadPyodide" in value &&
    typeof value.loadPyodide === "function"
  );
}

function isWasmModule(value: unknown): value is WasmModule {
  return (
    typeof value === "object" &&
    value !== null &&
    "create_bridge" in value &&
    typeof value.create_bridge === "function" &&
    "destroy" in value &&
    typeof value.destroy === "function"
  );
}

function loadBundledPyodide(): PyodideModule {
  const require = NodeModule.createRequire(__filename);
  const module: unknown = require("../bundled/wasm/pyodide.js");
  if (!isPyodideModule(module)) {
    throw new TypeError("Bundled Pyodide module is invalid");
  }
  return module;
}

async function main(): Promise<void> {
  const wasmDir = NodePath.join(__dirname, "..", "bundled", "wasm");
  const { loadPyodide } = loadBundledPyodide();
  const pyodide = await loadPyodide({
    indexURL: wasmDir,
    stdout: (line) => process.stderr.write(`${line}\n`),
    stderr: (line) => process.stderr.write(`${line}\n`),
  });
  pyodide.FS.writeFile(
    "/marimo-lsp-site-packages.zip",
    NodeFs.readFileSync(NodePath.join(wasmDir, "site-packages.zip")),
  );
  pyodide.runPython(`
import shutil
shutil.unpack_archive("/marimo-lsp-site-packages.zip", "/lib/python3.14/site-packages")
`);

  const imported: unknown = pyodide.pyimport("marimo_lsp.wasm");
  if (!isWasmModule(imported)) {
    throw new TypeError("Bundled marimo_lsp.wasm module is invalid");
  }
  const writer = new StreamMessageWriter(process.stdout);
  const unsupportedProcesses = {
    spawn: () => {
      throw new Error("Native kernels are not available in this revision");
    },
    write: () => {},
    close: () => {},
  };
  const bridge = imported.create_bridge((messageJson: string) => {
    void writer.write(JSON.parse(messageJson));
  }, unsupportedProcesses);
  const reader = new StreamMessageReader(process.stdin);
  let resolveExit = () => {};
  const exitRequested = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  reader.listen((message) => {
    if ("method" in message && message.method === "exit") {
      resolveExit();
      return;
    }
    void bridge
      .handle_message(JSON.stringify(message))
      .catch((error: unknown) => {
        console.error(error);
        process.exitCode = 1;
        resolveExit();
      });
  });
  const stdinEnded = new Promise<void>((resolve, reject) => {
    process.stdin.once("end", resolve);
    process.stdin.once("error", reject);
  });
  await Promise.race([stdinEnded, exitRequested]);
  reader.dispose();
  process.stdin.pause();
  bridge.close();
  bridge.destroy();
  imported.destroy();
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
