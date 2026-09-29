import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Effect, Exit, Fiber, Layer, Option, Queue, Ref, Stream } from "effect";

import * as MarimoClientTest from "../../__tests__/fake/MarimoClient.ts";
import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import { MarimoLspServer } from "../../config/Config.ts";
import { kernelSessionId, notebookId } from "../../lib/__tests__/branded.ts";
import type { DocumentAnalysis, KernelNotification } from "../../types.ts";
import * as MarimoClient from "../MarimoClient.ts";

const notebook = notebookId("notebook-a");
const it = EffectTest.make(Layer.empty);

Vitest.describe("custom language-server failures", () => {
  const it = EffectTest.make(VsCodeTest.layer);

  type Mode = Parameters<
    typeof MarimoClient.makeCustomLspFailureNotifier
  >[0]["mode"];

  /** Builds one notifier per server mode, counting how often logs are shown. */
  const makeNotify = (modes: ReadonlyArray<Mode>, logs: { opened: number }) =>
    Effect.forEach(modes, (mode) =>
      MarimoClient.makeCustomLspFailureNotifier({
        mode,
        channel: {
          name: "marimo-lsp",
          show: () => {
            logs.opened += 1;
          },
        },
      }),
    ).pipe(Effect.map((notifiers) => Effect.all(notifiers, { discard: true })));

  it.effect(
    "prompts once and opens the selected recovery surface",
    Effect.fn(function* () {
      const vscode = yield* VsCodeTest.Service;
      const logs = { opened: 0 };
      const notify = yield* makeNotify(["configured"], logs);
      yield* vscode.selectErrorMessage("Open Settings");

      yield* Effect.all([notify, notify], { concurrency: "unbounded" });

      const snapshot = yield* vscode.snapshot;
      Vitest.expect(snapshot.errorMessages).toHaveLength(1);
      Vitest.expect(snapshot.errorMessages[0]).toContain(
        "Custom language servers are for extension development",
      );
      Vitest.expect(logs.opened).toBe(0);
      Vitest.expect(snapshot.executions).toContainEqual({
        command: "workbench.action.openSettings",
        args: ["marimo.lsp"],
      });
    }),
  );

  it.effect(
    "opens logs when selected",
    Effect.fn(function* () {
      const vscode = yield* VsCodeTest.Service;
      const logs = { opened: 0 };
      const notify = yield* makeNotify(["configured"], logs);
      yield* vscode.selectErrorMessage("Open Logs");

      yield* notify;

      Vitest.expect(logs.opened).toBe(1);
      Vitest.expect((yield* vscode.snapshot).executions).toEqual([]);
    }),
  );

  it.effect(
    "does not prompt for bundled language servers",
    Effect.fn(function* () {
      const vscode = yield* VsCodeTest.Service;
      const notify = yield* makeNotify(["wasm", "uv"], { opened: 0 });

      yield* notify;

      Vitest.expect((yield* vscode.snapshot).errorMessages).toEqual([]);
    }),
  );
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
    const calls = yield* Ref.make<ReadonlyArray<MarimoClientTest.Command>>([]);
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
  /**
   * Wires the client's notification streams to hand-driven transport
   * handlers so tests can publish raw messages and count registrations.
   */
  const makeNotifications = Effect.gen(function* () {
    let commandNotificationsRequested = false;
    let kernelRegistrations = 0;
    let documentRegistrations = 0;
    let kernelHandler: ((message: unknown) => void) | undefined;
    let documentHandler: ((message: unknown) => void) | undefined;
    const kernelSubscriptions = yield* Queue.unbounded<void>();
    const documentSubscriptions = yield* Queue.unbounded<void>();

    const kernelNotifications =
      yield* MarimoClient.makeKernelNotificationStream((handler) => {
        kernelRegistrations += 1;
        kernelHandler = handler;
        return { dispose() {} };
      });
    const documentAnalyses = yield* MarimoClient.makeDocumentAnalysisStream(
      (handler) => {
        documentRegistrations += 1;
        documentHandler = handler;
        return { dispose() {} };
      },
    );
    const commands = MarimoClient.makeCommands({
      send: () => Effect.void,
      kernelNotifications: Stream.suspend(() => {
        commandNotificationsRequested = true;
        return Stream.empty;
      }),
    });

    const awaitSubscriptions = (
      subscriptions: Queue.Queue<void>,
      count: number,
    ) =>
      Effect.forEach(
        Array.from({ length: count }),
        () => Queue.take(subscriptions),
        { discard: true },
      );
    const take = <A>(
      stream: Stream.Stream<A>,
      subscriptions: Queue.Queue<void>,
    ) =>
      Queue.offer(subscriptions, undefined).pipe(
        Effect.andThen(stream.pipe(Stream.take(1), Stream.runHead)),
      );
    const publish =
      (handler: () => ((message: unknown) => void) | undefined, name: string) =>
      (message: unknown) =>
        Effect.suspend(() => {
          const current = handler();
          return current === undefined
            ? Effect.die(`${name} handler is not registered`)
            : Effect.sync(() => current(message));
        });

    return {
      drainCommandNotifications: commands.kernelNotifications.pipe(
        Stream.runDrain,
      ),
      takeKernel: take(kernelNotifications, kernelSubscriptions),
      takeDocumentAnalysis: take(documentAnalyses, documentSubscriptions),
      awaitKernelSubscriptions: (count: number) =>
        awaitSubscriptions(kernelSubscriptions, count),
      awaitDocumentSubscriptions: (count: number) =>
        awaitSubscriptions(documentSubscriptions, count),
      publishKernel: publish(() => kernelHandler, "Kernel notification"),
      publishDocumentAnalysis: publish(
        () => documentHandler,
        "Document analysis",
      ),
      snapshot: Effect.sync(() => ({
        commandNotificationsRequested,
        kernelRegistrations,
        documentRegistrations,
      })),
    };
  });

  it.effect(
    "subscribes to kernel notifications",
    Effect.fn(function* () {
      const notifications = yield* makeNotifications;
      yield* notifications.drainCommandNotifications;

      Vitest.expect(
        (yield* notifications.snapshot).commandNotificationsRequested,
      ).toBe(true);
    }),
  );

  it.effect(
    "broadcasts kernel notifications without replacing the transport handler",
    Effect.fn(function* () {
      const notifications = yield* makeNotifications;
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
      const notifications = yield* makeNotifications;
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
      const notifications = yield* makeNotifications;
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
