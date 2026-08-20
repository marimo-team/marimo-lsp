import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref } from "effect";
import { TestClock } from "effect/testing";

import { Uri } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import type { MarimoApiCall } from "../../types.ts";
import { loadSavedSessionOutputs } from "../loadSavedSessionOutputs.ts";

const isWindows = NodeProcess.platform === "win32";

it.effect(
  "does not probe non-file notebooks",
  Effect.fn(function* () {
    const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const layer = Layer.merge(
      NodeServices.layer,
      makeTestMarimoClient({
        execute: (request) =>
          Ref.update(calls, (current) => [...current, request]),
      }),
    );
    const uri = Uri.parse("untitled:Untitled-1");

    const result = yield* loadSavedSessionOutputs({
      notebook: { isClosed: false, uri, version: 1 },
      executable: "/does/not/exist",
      workingDirectory: "/does/not/exist",
    }).pipe(Effect.provide(layer));

    assert(Option.isNone(result));
    expect(yield* Ref.get(calls)).toEqual([]);
  }),
);

it.effect(
  "does not probe a missing or non-file notebook path",
  Effect.fn(function* () {
    const directory = yield* tempDirectory;
    const missing = Uri.file(NodePath.join(directory, "missing.py"));
    const directoryPath = NodePath.join(directory, "directory.py");
    NodeFs.mkdirSync(directoryPath);
    const layer = Layer.merge(
      NodeServices.layer,
      makeTestMarimoClient({ execute: () => Effect.die("unexpected call") }),
    );

    for (const notebookUri of [missing, Uri.file(directoryPath)]) {
      const result = yield* loadSavedSessionOutputs({
        notebook: { isClosed: false, uri: notebookUri, version: 1 },
        executable: "/does/not/exist",
        workingDirectory: directory,
      }).pipe(Effect.provide(layer));
      assert(Option.isNone(result));
    }
  }),
);

describe.skipIf(isWindows)("loadSavedSessionOutputs", () => {
  it.effect(
    "reads the located sidecar and sends its contents with exact provenance",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const workingDirectory = NodePath.join(directory, "working directory");
      NodeFs.mkdirSync(workingDirectory);
      const notebookPath = NodePath.join(
        directory,
        "notebook 'Δ' with spaces\nand newline.py",
      );
      NodeFs.writeFileSync(notebookPath, "# notebook");
      const cachePath = NodePath.join(directory, "saved session.json");
      const invocationPath = NodePath.join(directory, "invocation.txt");
      const executable = makeProbeExecutable(directory, {
        name: "python",
        result: JSON.stringify({
          marimoVersion: "0.24.0.dev1+local",
          cachePath,
        }),
        stdout: "sitecustomize noise",
        invocationPath,
      });
      NodeFs.writeFileSync(cachePath, "saved contents");

      const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
      const layer = Layer.merge(
        NodeServices.layer,
        makeTestMarimoClient({
          execute: (request) =>
            Ref.update(calls, (current) => [...current, request]).pipe(
              Effect.as({
                outputs: [
                  {
                    cellId: "cell-1",
                    output: {
                      channel: "output",
                      mimetype: "text/plain",
                      data: "42",
                    },
                    console: [],
                  },
                ],
                marimoVersion: "0.24.0.dev1+local",
                notebookVersion: 7,
              }),
            ),
        }),
      );
      const uri = Uri.file(notebookPath);

      const result = yield* loadSavedSessionOutputs({
        notebook: { isClosed: false, uri, version: 7 },
        executable,
        workingDirectory,
      }).pipe(Effect.provide(layer));

      assert(Option.isSome(result));
      expect(result.value).toEqual({
        outputs: [
          {
            cellId: "cell-1",
            output: {
              channel: "output",
              mimetype: "text/plain",
              data: "42",
            },
            console: [],
          },
        ],
        marimoVersion: "0.24.0.dev1+local",
        notebookVersion: 7,
      });
      expect(yield* Ref.get(calls)).toEqual([
        {
          method: "decode-saved-session",
          params: {
            notebookUri: uri.toString(),
            inner: {
              contents: "saved contents",
              marimoVersion: "0.24.0.dev1+local",
              notebookVersion: 7,
            },
          },
        },
      ]);
      expect(NodeFs.readFileSync(invocationPath, "utf8")).toBe(
        `${NodeFs.realpathSync(workingDirectory)}\n${notebookPath}`,
      );
    }),
  );

  it.effect(
    "treats an oversized sidecar as a cache miss before decoding",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const cachePath = NodePath.join(directory, "large.json");
      NodeFs.writeFileSync(cachePath, "");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      NodeFs.truncateSync(cachePath, 64 * 1024 * 1024 + 1);
      const executable = makeProbeExecutable(directory, {
        name: "python-large",
        result: JSON.stringify({ marimoVersion: "0.24.0", cachePath }),
      });
      const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
      const uri = Uri.file(notebookPath);

      const result = yield* loadSavedSessionOutputs({
        notebook: { isClosed: false, uri, version: 1 },
        executable,
        workingDirectory: directory,
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            makeTestMarimoClient({
              execute: (request) =>
                Ref.update(calls, (current) => [...current, request]),
            }),
          ),
        ),
      );

      assert(Option.isNone(result));
      expect(yield* Ref.get(calls)).toEqual([]);
    }),
  );

  it.effect(
    "treats malformed probe output and invalid UTF-8 as cache misses",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const invalidCachePath = NodePath.join(directory, "invalid.json");
      NodeFs.writeFileSync(invalidCachePath, Uint8Array.of(0xff));
      NodeFs.writeFileSync(notebookPath, "# notebook");
      const malformed = makeProbeExecutable(directory, {
        name: "python-malformed",
        result: "not a probe result",
      });
      const relativePath = makeProbeExecutable(directory, {
        name: "python-relative-path",
        result: JSON.stringify({
          marimoVersion: "0.24.0",
          cachePath: "relative/session.json",
        }),
      });
      const invalidUtf8 = makeProbeExecutable(directory, {
        name: "python-invalid-utf8",
        result: JSON.stringify({
          marimoVersion: "0.24.0",
          cachePath: invalidCachePath,
        }),
      });
      const uri = Uri.file(notebookPath);
      const layer = Layer.merge(
        NodeServices.layer,
        makeTestMarimoClient({ execute: () => Effect.die("unexpected call") }),
      );

      for (const executable of [malformed, relativePath, invalidUtf8]) {
        const result = yield* loadSavedSessionOutputs({
          notebook: { isClosed: false, uri, version: 1 },
          executable,
          workingDirectory: directory,
        }).pipe(Effect.provide(layer));
        assert(Option.isNone(result));
      }
    }),
  );

  it.effect(
    "bounds a stalled language-server decode request",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const cachePath = NodePath.join(directory, "saved.json");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      NodeFs.writeFileSync(cachePath, "saved contents");
      const executable = makeProbeExecutable(directory, {
        name: "python-stalled-api",
        result: JSON.stringify({ marimoVersion: "0.24.0", cachePath }),
      });
      const started = yield* Deferred.make<void>();
      const layer = Layer.merge(
        NodeServices.layer,
        makeTestMarimoClient({
          execute: () =>
            Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
            ),
        }),
      );
      const uri = Uri.file(notebookPath);
      const fiber = yield* loadSavedSessionOutputs({
        notebook: { isClosed: false, uri, version: 1 },
        executable,
        workingDirectory: directory,
      }).pipe(Effect.provide(layer), Effect.forkChild);

      yield* Deferred.await(started);
      yield* TestClock.adjust("10 seconds");

      assert(Option.isNone(yield* Fiber.join(fiber)));
    }),
  );

  it.effect(
    "drops a result when the notebook changes during decoding",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const cachePath = NodePath.join(directory, "saved.json");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      NodeFs.writeFileSync(cachePath, "saved contents");
      const executable = makeProbeExecutable(directory, {
        name: "python-edited-notebook",
        result: JSON.stringify({ marimoVersion: "0.24.0", cachePath }),
      });
      const notebook = {
        isClosed: false,
        uri: Uri.file(notebookPath),
        version: 1,
      };
      const layer = Layer.merge(
        NodeServices.layer,
        makeTestMarimoClient({
          execute: () =>
            Effect.sync(() => {
              notebook.version = 2;
              return {
                outputs: [],
                marimoVersion: "0.24.0",
                notebookVersion: 1,
              };
            }),
        }),
      );

      const result = yield* loadSavedSessionOutputs({
        notebook,
        executable,
        workingDirectory: directory,
      }).pipe(Effect.provide(layer));

      assert(Option.isNone(result));
    }),
  );

  it.effect(
    "drops a result when the notebook closes during decoding",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const cachePath = NodePath.join(directory, "saved.json");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      NodeFs.writeFileSync(cachePath, "saved contents");
      const executable = makeProbeExecutable(directory, {
        name: "python-closed-notebook",
        result: JSON.stringify({ marimoVersion: "0.24.0", cachePath }),
      });
      const notebook = {
        isClosed: false,
        uri: Uri.file(notebookPath),
        version: 1,
      };
      const layer = Layer.merge(
        NodeServices.layer,
        makeTestMarimoClient({
          execute: () =>
            Effect.sync(() => {
              notebook.isClosed = true;
              return {
                outputs: [],
                marimoVersion: "0.24.0",
                notebookVersion: 1,
              };
            }),
        }),
      );

      const result = yield* loadSavedSessionOutputs({
        notebook,
        executable,
        workingDirectory: directory,
      }).pipe(Effect.provide(layer));

      assert(Option.isNone(result));
    }),
  );

  it.effect(
    "force-kills a probe that ignores graceful termination",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const pidPath = NodePath.join(directory, "probe.pid");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      const executable = makeStalledExecutable(directory, pidPath);
      const uri = Uri.file(notebookPath);
      const layer = Layer.merge(
        NodeServices.layer,
        makeTestMarimoClient({ execute: () => Effect.die("unexpected call") }),
      );
      const fiber = yield* loadSavedSessionOutputs({
        notebook: { isClosed: false, uri, version: 1 },
        executable,
        workingDirectory: directory,
      }).pipe(Effect.provide(layer), Effect.forkChild);
      const pid = yield* Effect.promise(() => waitForPid(pidPath, 100));

      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      assert(Option.isNone(yield* Fiber.join(fiber)));
      expect(() => NodeProcess.kill(pid, 0)).toThrow();
    }),
  );

  it.effect(
    "kills descendants left by a successful probe",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const cachePath = NodePath.join(directory, "saved.json");
      const pidPath = NodePath.join(directory, "descendant.pid");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      NodeFs.writeFileSync(cachePath, "saved contents");
      const executable = makeExitedLeaderExecutable(directory, {
        cachePath,
        pidPath,
      });
      const uri = Uri.file(notebookPath);
      const layer = Layer.merge(
        NodeServices.layer,
        makeTestMarimoClient({
          execute: () =>
            Effect.succeed({
              outputs: [],
              marimoVersion: "0.24.0",
              notebookVersion: 1,
            }),
        }),
      );

      const result = yield* loadSavedSessionOutputs({
        notebook: { isClosed: false, uri, version: 1 },
        executable,
        workingDirectory: directory,
      }).pipe(Effect.provide(layer));

      assert(Option.isSome(result));
      const pid = Number.parseInt(NodeFs.readFileSync(pidPath, "utf8"), 10);
      yield* Effect.promise(() => waitForProcessExit(pid, 100));
    }),
  );
});

const tempDirectory = Effect.acquireRelease(
  Effect.sync(
    () =>
      NodeFs.mkdtempDisposableSync(
        NodePath.join(NodeOs.tmpdir(), "marimo-saved-session-"),
      ).path,
  ),
  (path) => Effect.sync(() => NodeFs.rmSync(path, { recursive: true })),
);

function makeProbeExecutable(
  directory: string,
  options: {
    readonly name: string;
    readonly result: string;
    readonly stdout?: string;
    readonly invocationPath?: string;
  },
) {
  const executable = NodePath.join(directory, options.name);
  const lines = ["#!/bin/bash"];
  if (options.invocationPath !== undefined) {
    lines.push(
      `printf '%s\\n%s' "$PWD" "$3" > ${shellEscape(options.invocationPath)}`,
    );
  }
  if (options.stdout !== undefined) {
    lines.push(`printf '%s' ${shellEscape(options.stdout)}`);
  }
  lines.push(`printf '%s' ${shellEscape(options.result)} > "$4"`);
  NodeFs.writeFileSync(executable, lines.join("\n"), { mode: 0o755 });
  return executable;
}

function makeExitedLeaderExecutable(
  directory: string,
  options: { readonly cachePath: string; readonly pidPath: string },
) {
  const executable = NodePath.join(directory, "python-exited-probe");
  const descendant = [
    'process.on("SIGTERM", () => {});',
    "setInterval(() => {}, 1000);",
  ].join("");
  const result = JSON.stringify({
    marimoVersion: "0.24.0",
    cachePath: options.cachePath,
  });
  NodeFs.writeFileSync(
    executable,
    [
      "#!/bin/bash",
      `node -e ${shellEscape(descendant)} >/dev/null 2>&1 &`,
      `printf '%s' "$!" > ${shellEscape(options.pidPath)}`,
      `printf '%s' ${shellEscape(result)} > "$4"`,
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

function makeStalledExecutable(directory: string, pidPath: string) {
  const executable = NodePath.join(directory, "python-stalled-probe");
  NodeFs.writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'const fs = require("node:fs");',
      'process.on("SIGTERM", () => {});',
      `fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));`,
      "setInterval(() => {}, 1000);",
    ].join("\n"),
    { mode: 0o755 },
  );
  return executable;
}

async function waitForPid(pidPath: string, attempts: number): Promise<number> {
  try {
    return Number.parseInt(NodeFs.readFileSync(pidPath, "utf8"), 10);
  } catch {
    if (attempts === 0) throw new Error("probe did not start");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    return waitForPid(pidPath, attempts - 1);
  }
}

async function waitForProcessExit(
  pid: number,
  attempts: number,
): Promise<void> {
  try {
    NodeProcess.kill(pid, 0);
  } catch {
    return;
  }
  if (attempts === 0) throw new Error(`process ${pid} is still running`);
  await new Promise<void>((resolve) => setTimeout(resolve, 10));
  return waitForProcessExit(pid, attempts - 1);
}

function shellEscape(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
