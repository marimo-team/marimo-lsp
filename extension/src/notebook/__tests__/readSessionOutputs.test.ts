import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { NodeServices } from "@effect/platform-node";
import { assert, describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";

import { Uri } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import type { MarimoApiCall } from "../../types.ts";
import { readSessionOutputs } from "../readSessionOutputs.ts";

const isWindows = NodeProcess.platform === "win32";
const notification = {
  op: "cell-op",
  cell_id: "cell-1",
  output: {
    channel: "output",
    mimetype: "text/plain",
    data: "42",
  },
  console: [],
} as const;

it.effect(
  "asks for a live replay without probing a non-file notebook",
  Effect.fn(function* () {
    const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const uri = Uri.parse("untitled:Untitled-1");
    const result = yield* readSessionOutputs({
      notebook: { isClosed: false, uri },
      environment: {
        executable: "/does/not/exist",
        workingDirectory: "/does/not/exist",
      },
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          makeTestMarimoClient({
            execute: (request) =>
              Ref.update(calls, (current) => [...current, request]).pipe(
                Effect.as({ notifications: [notification] }),
              ),
          }),
        ),
      ),
    );

    expect(result).toEqual([notification]);
    expect(yield* Ref.get(calls)).toEqual([
      {
        method: "read-session-outputs",
        params: { notebookUri: uri.toString(), inner: { location: null } },
      },
    ]);
  }),
);

it.effect(
  "discards a replay when the notebook closes during the request",
  Effect.fn(function* () {
    const requested = yield* Deferred.make<void>();
    const response = yield* Deferred.make<{
      notifications: ReadonlyArray<typeof notification>;
    }>();
    const notebook = {
      isClosed: false,
      uri: Uri.parse("untitled:Untitled-1"),
    };
    const fiber = yield* readSessionOutputs({ notebook }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          makeTestMarimoClient({
            execute: () =>
              Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Deferred.await(response)),
              ),
          }),
        ),
      ),
      Effect.forkChild,
    );

    yield* Deferred.await(requested);
    notebook.isClosed = true;
    yield* Deferred.succeed(response, { notifications: [notification] });

    expect(yield* Fiber.join(fiber)).toEqual([]);
  }),
);

it.effect(
  "interrupts an in-flight language-server read",
  Effect.fn(function* () {
    const requested = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const fiber = yield* readSessionOutputs({
      notebook: {
        isClosed: false,
        uri: Uri.parse("untitled:Untitled-1"),
      },
    }).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          makeTestMarimoClient({
            execute: () =>
              Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              ),
          }),
        ),
      ),
      Effect.forkChild,
    );

    yield* Deferred.await(requested);
    yield* Fiber.interrupt(fiber);

    expect(yield* Deferred.isDone(interrupted)).toBe(true);
  }),
);

describe.skipIf(isWindows)("readSessionOutputs", () => {
  it.effect(
    "sends only the selected environment's location",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const workingDirectory = NodePath.join(directory, "working directory");
      NodeFs.mkdirSync(workingDirectory);
      const notebookPath = NodePath.join(directory, "notebook with spaces.py");
      const cachePath = NodePath.join(directory, "saved session.json");
      const invocationPath = NodePath.join(directory, "invocation.txt");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      const executable = makeProbeExecutable(directory, {
        name: "python",
        result: JSON.stringify({
          marimoVersion: "0.24.0.dev1+local",
          cachePath,
        }),
        stdout: "sitecustomize noise",
        invocationPath,
      });
      const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
      const uri = Uri.file(notebookPath);

      const result = yield* readSessionOutputs({
        notebook: { isClosed: false, uri },
        environment: { executable, workingDirectory },
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            makeTestMarimoClient({
              execute: (request) =>
                Ref.update(calls, (current) => [...current, request]).pipe(
                  Effect.as({ notifications: [notification] }),
                ),
            }),
          ),
        ),
      );

      expect(result).toEqual([notification]);
      expect(yield* Ref.get(calls)).toEqual([
        {
          method: "read-session-outputs",
          params: {
            notebookUri: uri.toString(),
            inner: {
              location: {
                cachePath,
                marimoVersion: "0.24.0.dev1+local",
              },
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
    "runs a probe through an existing sandbox environment",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "sandbox.py");
      const cachePath = NodePath.join(directory, "saved session.json");
      NodeFs.writeFileSync(notebookPath, "# /// script");
      const executable = makeProbeExecutable(directory, {
        name: "uv",
        result: JSON.stringify({
          marimoVersion: "0.24.0",
          cachePath,
        }),
        expectedPrefix: "run --no-sync --script sandbox.py python",
      });
      const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
      const uri = Uri.file(notebookPath);

      yield* readSessionOutputs({
        notebook: { isClosed: false, uri },
        environment: {
          executable,
          arguments: ["run", "--no-sync", "--script", "sandbox.py", "python"],
          workingDirectory: directory,
        },
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            makeTestMarimoClient({
              execute: (request) =>
                Ref.update(calls, (current) => [...current, request]).pipe(
                  Effect.as({ notifications: [] }),
                ),
            }),
          ),
        ),
      );

      expect(yield* Ref.get(calls)).toEqual([
        {
          method: "read-session-outputs",
          params: {
            notebookUri: uri.toString(),
            inner: {
              location: { cachePath, marimoVersion: "0.24.0" },
            },
          },
        },
      ]);
    }),
  );

  it.effect(
    "falls back to a live replay when the probe is invalid",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      const executable = makeProbeExecutable(directory, {
        name: "python-invalid",
        result: JSON.stringify({
          marimoVersion: "0.24.0",
          cachePath: "relative/session.json",
        }),
      });
      const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
      const uri = Uri.file(notebookPath);

      const result = yield* readSessionOutputs({
        notebook: { isClosed: false, uri },
        environment: { executable, workingDirectory: directory },
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            makeTestMarimoClient({
              execute: (request) =>
                Ref.update(calls, (current) => [...current, request]).pipe(
                  Effect.as({ notifications: [] }),
                ),
            }),
          ),
        ),
      );

      expect(result).toEqual([]);
      expect(yield* Ref.get(calls)).toEqual([
        {
          method: "read-session-outputs",
          params: { notebookUri: uri.toString(), inner: { location: null } },
        },
      ]);
    }),
  );

  it.effect(
    "force-kills a probe that ignores cancellation",
    Effect.fn(function* () {
      const directory = yield* tempDirectory;
      const notebookPath = NodePath.join(directory, "notebook.py");
      const pidPath = NodePath.join(directory, "probe.pid");
      NodeFs.writeFileSync(notebookPath, "# notebook");
      const executable = makeStalledExecutable(directory, pidPath);
      const uri = Uri.file(notebookPath);
      const fiber = yield* readSessionOutputs({
        notebook: { isClosed: false, uri },
        environment: { executable, workingDirectory: directory },
      }).pipe(
        Effect.provide(
          Layer.merge(
            NodeServices.layer,
            makeTestMarimoClient({
              execute: () => Effect.succeed({ notifications: [] }),
            }),
          ),
        ),
        Effect.forkChild,
      );
      const pid = yield* Effect.promise(() => waitForPid(pidPath, 100));

      yield* TestClock.adjust("10 seconds");
      yield* Effect.yieldNow;
      yield* TestClock.adjust("1 second");

      assert.deepStrictEqual(yield* Fiber.join(fiber), []);
      expect(() => NodeProcess.kill(pid, 0)).toThrow();
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
    readonly expectedPrefix?: string;
  },
) {
  const executable = NodePath.join(directory, options.name);
  const lines = ["#!/bin/bash"];
  if (options.expectedPrefix !== undefined) {
    lines.push(
      `[ "$1 $2 $3 $4 $5" = ${shellEscape(options.expectedPrefix)} ] || exit 1`,
    );
  }
  if (options.invocationPath !== undefined) {
    lines.push(
      `printf '%s\\n%s' "$PWD" "\${@: -2:1}" > ${shellEscape(options.invocationPath)}`,
    );
  }
  if (options.stdout !== undefined) {
    lines.push(`printf '%s' ${shellEscape(options.stdout)}`);
  }
  lines.push(`printf '%s' ${shellEscape(options.result)} > "\${@: -1}"`);
  NodeFs.writeFileSync(executable, lines.join("\n"), { mode: 0o755 });
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

function shellEscape(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
