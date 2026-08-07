// @ts-check
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import { StreamMessageReader } from "vscode-jsonrpc/node";

const TIMEOUT_MS = 20_000;
const extensionDir = NodePath.dirname(
  NodeUrl.fileURLToPath(new URL("../package.json", import.meta.url)),
);
const repositoryDir = NodePath.dirname(extensionDir);
const kernelPython = NodeChildProcess.execFileSync(
  "uv",
  ["run", "python", "-c", "import sys; print(sys.executable)"],
  {
    cwd: repositoryDir,
    encoding: "utf8",
  },
).trim();
const child = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(extensionDir, "dist", "wasmServer.js")],
  { stdio: ["pipe", "pipe", "pipe"] },
);
/** @type {Buffer[]} */
const stdout = [];
/** @type {Buffer[]} */
const stderr = [];
child.stdout.on("data", (chunk) => stdout.push(chunk));
child.stderr.on("data", (chunk) => stderr.push(chunk));

const reader = new StreamMessageReader(child.stdout);
/** @type {Map<number, (message: unknown) => void>} */
const responses = new Map();
reader.listen((message) => {
  if ("id" in message && typeof message.id === "number") {
    responses.get(message.id)?.(message);
    responses.delete(message.id);
  }
});

/** @param {number} id */
function response(id) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      responses.delete(id);
      child.kill();
      reject(
        new Error(
          `Timed out waiting for response ${id}\n${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    }, TIMEOUT_MS);
    responses.set(id, (message) => {
      clearTimeout(timeout);
      resolve(message);
    });
  });
}

/** @param {unknown} message */
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  child.stdin.write(body);
}

/** @param {RegExp} pattern */
function waitForOutput(pattern) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Timed out waiting for ${pattern}\n${Buffer.concat(stdout).toString("utf8")}\n${Buffer.concat(stderr).toString("utf8")}`,
        ),
      );
    }, 20_000);
    const inspect = () => {
      if (!pattern.test(Buffer.concat(stdout).toString("utf8"))) return;
      clearTimeout(timeout);
      child.stdout.off("data", inspect);
      resolve(undefined);
    };
    child.stdout.on("data", inspect);
    inspect();
  });
}

const initialized = response(1);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { processId: process.pid, capabilities: {}, rootUri: null },
});
const initializeMessage = await initialized;
send({ jsonrpc: "2.0", method: "initialized", params: {} });

const notebookUri = "file:///tmp/marimo-wasm-smoke.py";
const cellUri =
  "vscode-notebook-cell:///tmp/marimo-wasm-smoke.py#W0sZmlsZQ%3D%3D";
send({
  jsonrpc: "2.0",
  method: "notebookDocument/didOpen",
  params: {
    notebookDocument: {
      uri: notebookUri,
      notebookType: "marimo-notebook",
      version: 1,
      cells: [{ kind: 2, document: cellUri }],
    },
    cellTextDocuments: [
      { uri: cellUri, languageId: "python", version: 1, text: "x = 1" },
    ],
  },
});

const executed = response(2);
send({
  jsonrpc: "2.0",
  id: 2,
  method: "workspace/executeCommand",
  params: {
    command: "marimo.api",
    arguments: [
      {
        method: "execute-cells",
        params: {
          notebookUri,
          executable: kernelPython,
          workingDirectory: repositoryDir,
          inner: { cellIds: ["cell"], codes: ["x = 1"] },
        },
      },
    ],
  },
});
await executed;
await waitForOutput(/"op":"completed-run"/);

const shutdown = response(3);
send({ jsonrpc: "2.0", id: 3, method: "shutdown", params: null });
await shutdown;
send({ jsonrpc: "2.0", method: "exit", params: null });
child.stdin.end();

const exitCode = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => {
    child.kill();
    reject(
      new Error(
        `Timed out waiting for WASM server exit\n${Buffer.concat(stderr).toString("utf8")}`,
      ),
    );
  }, TIMEOUT_MS);
  child.once("error", reject);
  child.once("exit", (code) => {
    clearTimeout(timeout);
    resolve(code);
  });
});
const errors = Buffer.concat(stderr).toString("utf8");
const output = Buffer.concat(stdout).toString("utf8");
NodeAssert.equal(exitCode, 0, errors);
NodeAssert.equal(initializeMessage.result.serverInfo.name, "marimo-lsp");
NodeAssert.match(output, /"method":"marimo\/operation"/);
NodeAssert.match(output, /"op":"completed-run"/);
NodeAssert.match(
  output,
  /"op":"variable-values","variables":\[\{"name":"x","value":"1"/,
);
console.log("WASM language-server smoke test passed");
