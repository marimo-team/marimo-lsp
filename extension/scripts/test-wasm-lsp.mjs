// @ts-check
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

const extensionDir = NodePath.dirname(
  NodeUrl.fileURLToPath(new URL("../package.json", import.meta.url)),
);
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

/** @param {unknown} message */
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  child.stdin.write(`Content-Length: ${body.byteLength}\r\n\r\n`);
  child.stdin.write(body);
}

send({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { processId: process.pid, capabilities: {}, rootUri: null },
});
send({ jsonrpc: "2.0", method: "initialized", params: {} });
send({ jsonrpc: "2.0", id: 2, method: "shutdown", params: null });
send({ jsonrpc: "2.0", method: "exit", params: null });
child.stdin.end();

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", resolve);
});
const output = Buffer.concat(stdout).toString("utf8");
const errors = Buffer.concat(stderr).toString("utf8");
NodeAssert.equal(exitCode, 0, errors);
NodeAssert.match(output, /"serverInfo":\{"name":"marimo-lsp"/);
console.log("WASM language-server smoke test passed");
