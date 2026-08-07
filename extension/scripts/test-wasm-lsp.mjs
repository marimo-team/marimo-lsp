// @ts-check
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
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

const notebookPath = NodePath.join(
  NodeOs.tmpdir(),
  `marimo-wasm-smoke-${process.pid}.py`,
);
NodeFs.writeFileSync(notebookPath, "", { flag: "wx" });
process.on("exit", () => NodeFs.rmSync(notebookPath, { force: true }));
const notebookUri = NodeUrl.pathToFileURL(notebookPath).href;
const notebookCellUri = notebookUri.replace(/^file:/, "vscode-notebook-cell:");
const sliderCellUri = `${notebookCellUri}#W0sZmlsZQ%3D%3D`;
const valueCellUri = `${notebookCellUri}#W1sZmlsZQ%3D%3D`;
const sliderCode = [
  "import marimo as mo",
  "slider = mo.ui.slider(0, 100)",
  "slider",
].join("\n");
const valueCode = [
  "import time",
  "time.sleep(0.01)",
  "value = slider.value",
  'print(f"slider-value:{value}")',
].join("\n");
send({
  jsonrpc: "2.0",
  method: "notebookDocument/didOpen",
  params: {
    notebookDocument: {
      uri: notebookUri,
      notebookType: "marimo-notebook",
      version: 1,
      cells: [
        { kind: 2, document: sliderCellUri },
        { kind: 2, document: valueCellUri },
      ],
    },
    cellTextDocuments: [
      {
        uri: sliderCellUri,
        languageId: "python",
        version: 1,
        text: sliderCode,
      },
      {
        uri: valueCellUri,
        languageId: "python",
        version: 1,
        text: valueCode,
      },
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
          inner: {
            cellIds: ["slider-cell", "value-cell"],
            codes: [sliderCode, valueCode],
          },
        },
      },
    ],
  },
});
await executed;
await waitForOutput(/"op":"completed-run"/);
await waitForOutput(/slider-value:0/);

const initialOutput = Buffer.concat(stdout).toString("utf8");
const sliderId = initialOutput.match(/object-id='([^']+)'/)?.[1];
NodeAssert.ok(
  sliderId,
  `Could not find slider ID in output:\n${initialOutput}`,
);

/** @type {Promise<unknown>[]} */
const updates = [];
for (let value = 1; value <= 100; value++) {
  const id = value + 10;
  updates.push(response(id));
  send({
    jsonrpc: "2.0",
    id,
    method: "workspace/executeCommand",
    params: {
      command: "marimo.api",
      arguments: [
        {
          method: "update-ui-element",
          params: {
            notebookUri,
            inner: { objectIds: [sliderId], values: [value] },
          },
        },
      ],
    },
  });
}
await Promise.all(updates);
await waitForOutput(/slider-value:100/);

const longRun = response(300);
send({
  jsonrpc: "2.0",
  id: 300,
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
          inner: {
            cellIds: ["value-cell"],
            codes: [
              'print("interrupt-started", flush=True)\n' +
                "time.sleep(60)\n" +
                "value = slider.value",
            ],
          },
        },
      },
    ],
  },
});
await longRun;
await waitForOutput(/interrupt-started/);

const interrupted = response(301);
send({
  jsonrpc: "2.0",
  id: 301,
  method: "workspace/executeCommand",
  params: {
    command: "marimo.api",
    arguments: [
      {
        method: "interrupt",
        params: { notebookUri, inner: {} },
      },
    ],
  },
});
await interrupted;
await waitForOutput(/"op":"interrupted"/);

const shutdown = response(200);
send({ jsonrpc: "2.0", id: 200, method: "shutdown", params: null });
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
NodeAssert.match(output, /slider-value:100/);
NodeAssert.match(output, /"op":"interrupted"/);
NodeAssert.doesNotMatch(output, /"channel":"marimo-error"/);
console.log("WASM language-server UI update and interrupt test passed");
