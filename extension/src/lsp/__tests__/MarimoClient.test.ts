import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Ref, Stream } from "effect";

import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import type { TestCommand } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { MarimoLspServer } from "../../config/Config.ts";
import { kernelSessionId, notebookId } from "../../lib/__tests__/branded.ts";
import type { DocumentAnalysis, KernelNotification } from "../../types.ts";
import * as MarimoClient from "../MarimoClient.ts";
import * as TestCustomLspFailure from "./TestCustomLspFailure.ts";
import * as TestMarimoNotifications from "./TestMarimoNotifications.ts";

const notebook = notebookId("notebook-a");
const it = EffectTest.make(Layer.empty);

Vitest.describe("custom language-server failures", () => {
  const it = EffectTest.make(
    TestCustomLspFailure.layerWith(
      TestCustomLspFailure.Scenario.OpenSettings(),
    ),
  );

  it.effect(
    "prompts once and opens the selected recovery surface",
    Effect.fn(function* () {
      const recovery = yield* TestCustomLspFailure.Service;

      yield* Effect.all([recovery.notify, recovery.notify], {
        concurrency: "unbounded",
      });

      const snapshot = yield* recovery.snapshot;
      Vitest.expect(snapshot.prompts).toHaveLength(1);
      Vitest.expect(snapshot.prompts[0]).toContain(
        "Custom language servers are for extension development",
      );
      Vitest.expect(snapshot.logsOpened).toBe(0);
      Vitest.expect(snapshot.executions).toContainEqual({
        command: "workbench.action.openSettings",
        args: ["marimo.lsp"],
      });
    }),
  );

  Vitest.describe("when logs are selected", () => {
    const it = EffectTest.make(
      TestCustomLspFailure.layerWith(TestCustomLspFailure.Scenario.OpenLogs()),
    );

    it.effect(
      "opens logs when selected",
      Effect.fn(function* () {
        const recovery = yield* TestCustomLspFailure.Service;
        yield* recovery.notify;

        const snapshot = yield* recovery.snapshot;
        Vitest.expect(snapshot.logsOpened).toBe(1);
        Vitest.expect(snapshot.executions).toEqual([]);
      }),
    );
  });

  Vitest.describe("for bundled language servers", () => {
    const it = EffectTest.make(
      TestCustomLspFailure.layerWith(TestCustomLspFailure.Scenario.Bundled()),
    );

    it.effect(
      "does not prompt for bundled language servers",
      Effect.fn(function* () {
        const recovery = yield* TestCustomLspFailure.Service;
        yield* recovery.notify;
        Vitest.expect((yield* recovery.snapshot).prompts).toEqual([]);
      }),
    );
  });
});

it.effect(
  "does not fail scope cleanup when language-client disposal rejects",
  Effect.fn(function* () {
    let disposals = 0;
    const dispose = () => {
      disposals += 1;
      return Promise.reject(new Error("client is startFailed"));
    };

    yield* MarimoClient.disposeLanguageClient({ dispose });

    Vitest.expect(disposals).toBe(1);
  }),
);

it.effect(
  "constructs private commands through named methods",
  Effect.fn(function* () {
    const calls = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
    const responses: Record<string, unknown> = {
      execute: {
        generation: 1,
        revision: 1,
        sessions: [],
      },
      "set-display-theme": { success: true },
    };
    const marimo = MarimoClient.makeCommands({
      send: (request) =>
        Ref.update(calls, (current) => [...current, request]).pipe(
          Effect.as(responses[request.kind]),
        ),
      kernelNotifications: Stream.empty,
    });

    yield* marimo.execute({
      notebookUri: notebook,
      executable: "/python",
      workingDirectory: "/workspace",
      cells: [],
    });
    yield* marimo.setDisplayTheme({ theme: "dark" });

    Vitest.assert.deepStrictEqual(yield* Ref.get(calls), [
      {
        kind: "execute",
        notebookUri: notebook,
        executable: "/python",
        workingDirectory: "/workspace",
        cells: [],
      },
      {
        kind: "set-display-theme",
        theme: "dark",
      },
    ]);
  }),
);

Vitest.describe("generated command client", () => {
  it.effect(
    "parses responses against the method's success schema",
    Effect.fn(function* () {
      const marimo = MarimoClient.makeCommands({
        send: () =>
          Effect.succeed({
            tree: { name: "root", version: null, tags: [], dependencies: [] },
          }),
        kernelNotifications: Stream.empty,
      });

      const response = yield* marimo.getDependencyTree({
        notebookUri: notebook,
        source: { kind: "script" },
      });

      // Response is parsed, not asserted: `tree` is a typed DependencyTreeNode.
      Vitest.assert.strictEqual(response.tree?.name, "root");
    }),
  );

  it.effect(
    "fails with ParseError when the server response violates the contract",
    Effect.fn(function* () {
      const marimo = MarimoClient.makeCommands({
        send: () => Effect.succeed({ tree: "not-a-tree" }),
        kernelNotifications: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          source: { kind: "script" },
        })
        .pipe(Effect.exit);

      Vitest.assert.isTrue(Exit.isFailure(exit));
      // The formatter names the schema and the path of the field that
      // failed. It does not name the response type that contains it.
      Vitest.assert.include(String(exit), "SchemaError");
      Vitest.assert.include(String(exit), "DependencyTreeNode");
      Vitest.assert.include(String(exit), '["tree"]');
    }),
  );

  it.effect(
    "rejects params the server would reject, before hitting the wire",
    Effect.fn(function* () {
      const marimo = MarimoClient.makeCommands({
        send: () => Effect.die("should not reach the transport"),
        kernelNotifications: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          // @ts-expect-error -- deliberately malformed source
          source: { kind: "conda" },
        })
        .pipe(Effect.exit);

      Vitest.assert.isTrue(Exit.isFailure(exit));
      Vitest.assert.include(String(exit), '["source"]');
      Vitest.assert.include(String(exit), 'readonly "kind": "venv"');
      Vitest.assert.include(String(exit), 'readonly "kind": "script"');
    }),
  );

  it.effect(
    "requires tagged-union discriminators before hitting the wire",
    Effect.fn(function* () {
      const marimo = MarimoClient.makeCommands({
        send: () => Effect.die("should not reach the transport"),
        kernelNotifications: Stream.empty,
      });

      const exit = yield* marimo
        .getDependencyTree({
          notebookUri: notebook,
          // @ts-expect-error -- msgspec requires `kind` for union decoding
          source: { executable: "/usr/bin/python3" },
        })
        .pipe(Effect.exit);

      Vitest.assert.isTrue(Exit.isFailure(exit));
      Vitest.assert.include(String(exit), '["source"]');
      Vitest.assert.include(String(exit), 'readonly "kind": "venv"');
      Vitest.assert.include(String(exit), 'readonly "kind": "script"');
    }),
  );
});

Vitest.describe("findMarimoLspExecutable", () => {
  it.live("uses a compatible Python range for the bundled LSP", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-client-"),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const sdist = NodePath.join(directory.path, "marimo_lsp-0.1.0");
          NodeFs.mkdirSync(sdist);

          const executable = yield* MarimoClient.findMarimoLspExecutable(
            "bundled-uv",
            directory.path,
          );

          Vitest.expect(executable).toEqual({
            command: "bundled-uv",
            args: [
              "tool",
              "run",
              "--python",
              ">=3.13,<3.15",
              "--from",
              sdist,
              "marimo-lsp",
            ],
          });
        }),
      (directory) => Effect.sync(() => directory.remove()),
    ),
  );
});

Vitest.describe("findWasmMarimoLspExecutable", () => {
  Vitest.it("launches the bundled server with VS Code's Node runtime", () => {
    const executable =
      MarimoClient.findWasmMarimoLspExecutable("/extension/dist");

    Vitest.expect(executable.command).toBe(process.execPath);
    Vitest.expect(executable.args).toEqual([
      NodePath.join("/extension/dist", "wasmServer.js"),
    ]);
    Vitest.expect(executable.options?.env?.ELECTRON_RUN_AS_NODE).toBe("1");
  });
});

Vitest.describe("selectMarimoLspExecutable", () => {
  it.effect(
    "uses the command carried by the custom server variant",
    Effect.fn(function* () {
      const selection = yield* MarimoClient.selectMarimoLspExecutable({
        server: MarimoLspServer.Custom({
          command: ["/custom/marimo-lsp", "--stdio"],
        }),
        resolveUvBinary: Effect.die("custom mode must not resolve uv"),
        searchDirectory: "/does/not/exist",
      });

      Vitest.expect(selection).toEqual({
        _tag: "Configured",
        exec: { command: "/custom/marimo-lsp", args: ["--stdio"] },
      });
    }),
  );

  it.effect(
    "uses WASM without resolving uv",
    Effect.fn(function* () {
      const selection = yield* MarimoClient.selectMarimoLspExecutable({
        server: MarimoLspServer.Wasm(),
        resolveUvBinary: Effect.die("WASM mode must not resolve uv"),
        searchDirectory: "/extension/dist",
      });

      Vitest.expect(selection._tag).toBe("Wasm");
      Vitest.expect(selection.exec.args).toEqual([
        NodePath.join("/extension/dist", "wasmServer.js"),
      ]);
    }),
  );

  it.live("resolves uv only for the Python server variant", () =>
    Effect.acquireUseRelease(
      Effect.sync(() =>
        NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-lsp-selection-"),
        ),
      ),
      (directory) =>
        Effect.gen(function* () {
          const selection = yield* MarimoClient.selectMarimoLspExecutable({
            server: MarimoLspServer.Python(),
            resolveUvBinary: Effect.succeed("bundled-uv"),
            searchDirectory: directory.path,
          });

          Vitest.expect(selection).toEqual({
            _tag: "Uv",
            exec: {
              command: "bundled-uv",
              args: ["run", "--directory", directory.path, "marimo-lsp"],
            },
          });
        }),
      (directory) => Effect.sync(() => directory.remove()),
    ),
  );
});

Vitest.describe("notification streams", () => {
  const it = EffectTest.make(TestMarimoNotifications.layer);

  it.effect(
    "subscribes to kernel notifications",
    Effect.fn(function* () {
      const notifications = yield* TestMarimoNotifications.Service;
      yield* notifications.drainCommandNotifications;

      Vitest.expect(
        (yield* notifications.snapshot).commandNotificationsRequested,
      ).toBe(true);
    }),
  );

  it.effect(
    "broadcasts kernel notifications without replacing the transport handler",
    Effect.fn(function* () {
      const notifications = yield* TestMarimoNotifications.Service;
      const first = yield* notifications.takeKernel.pipe(Effect.forkChild);
      const second = yield* notifications.takeKernel.pipe(Effect.forkChild);
      yield* notifications.awaitKernelSubscriptions(2);

      const message = {
        notebookUri: notebook,
        sessionId: kernelSessionId("00000000-0000-4000-8000-000000000001"),
        notification: { op: "completed-run", run_id: null },
      } as const;
      yield* notifications.publishKernel(message);

      Vitest.expect((yield* notifications.snapshot).kernelRegistrations).toBe(
        1,
      );
      Vitest.expect(yield* Fiber.join(first)).toEqual(Option.some(message));
      Vitest.expect(yield* Fiber.join(second)).toEqual(Option.some(message));
    }),
  );

  it.effect(
    "decodes document analysis on its own channel",
    Effect.fn(function* () {
      const notifications = yield* TestMarimoNotifications.Service;
      const received = yield* notifications.takeDocumentAnalysis.pipe(
        Effect.forkChild,
      );
      yield* notifications.awaitDocumentSubscriptions(1);
      const snapshot: DocumentAnalysis = {
        notebookUri: notebook,
        analysis: { op: "variables", variables: [] },
      };

      yield* notifications.publishDocumentAnalysis({
        notebookUri: notebook,
        analysis: { op: "datasets" },
      });
      yield* notifications.publishDocumentAnalysis(snapshot);

      Vitest.expect(yield* Fiber.join(received)).toEqual(Option.some(snapshot));
    }),
  );

  it.effect(
    "requires a kernel session ID even for kernel variable snapshots",
    Effect.fn(function* () {
      const notifications = yield* TestMarimoNotifications.Service;
      const received = yield* notifications.takeKernel.pipe(Effect.forkChild);
      yield* notifications.awaitKernelSubscriptions(1);
      const kernelSnapshot: KernelNotification = {
        notebookUri: notebook,
        sessionId: kernelSessionId("00000000-0000-4000-8000-000000000001"),
        notification: { op: "variables", variables: [] },
      };

      yield* notifications.publishKernel({
        ...kernelSnapshot,
        sessionId: undefined,
      });
      yield* notifications.publishKernel(kernelSnapshot);

      Vitest.expect(yield* Fiber.join(received)).toEqual(
        Option.some(kernelSnapshot),
      );
    }),
  );
});

it.effect(
  "disposes the transport notification handler with its scope",
  Effect.fn(function* () {
    let disposals = 0;

    yield* Effect.scoped(
      MarimoClient.makeKernelNotificationStream(() => ({
        dispose() {
          disposals += 1;
        },
      })).pipe(Effect.asVoid),
    );

    Vitest.expect(disposals).toBe(1);
  }),
);
