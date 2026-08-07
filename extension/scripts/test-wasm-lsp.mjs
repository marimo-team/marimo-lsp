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
const child = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(extensionDir, "dist", "wasmServer.js")],
  { stdio: ["pipe", "pipe", "pipe"] },
);
/** @type {Buffer[]} */
const stderr = [];
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

const initialized = response(1);
send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { processId: process.pid, capabilities: {}, rootUri: null },
});
const initializeMessage = await initialized;
send({ jsonrpc: "2.0", method: "initialized", params: {} });

const listed = response(2);
send({
  jsonrpc: "2.0",
  id: 2,
  method: "workspace/executeCommand",
  params: {
    command: "marimo.api",
    arguments: [{ method: "list-sessions", params: {} }],
  },
});
const listMessage = await listed;

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
NodeAssert.equal(exitCode, 0, errors);
NodeAssert.equal(initializeMessage.result.serverInfo.name, "marimo-lsp");
NodeAssert.deepEqual(listMessage.result, { sessions: [] });
console.log("WASM language-server smoke test passed");
