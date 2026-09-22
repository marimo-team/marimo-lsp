import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Logger,
  Option,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import {
  makeTestMarimoClient,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  cellId,
  kernelSessionId,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import type {
  CellOutputReplay,
  ListSessionsResponse,
} from "../../schemas/Models.gen.ts";
import {
  type NotebookController,
  NotebookRuntime,
} from "../NotebookRuntime.ts";

const notebook = notebookId("notebook-a");

const makeTestLayer = Effect.fn(function* (
  options: Parameters<typeof makeTestMarimoClient>[0] = {},
  vscodeOptions: Parameters<typeof TestVsCode.make>[0] = {},
) {
  const vscode = yield* TestVsCode.make(vscodeOptions);
  const serverSessions = new Map<
    ReturnType<typeof notebookId>,
    {
      sessionId: ReturnType<typeof kernelSessionId>;
      notebookUri: ReturnType<typeof notebookId>;
      filename: string;
      executable: string;
      workingDirectory: string;
      startedAt: number;
      status: "idle";
      attached: boolean;
    }
  >();
  const send = options.send ?? (() => Effect.succeed(null));
  let nextSessionId = 1;
  let revision = 0;
  const snapshot = () => ({
    generation: 1,
    revision: ++revision,
    sessions: [...serverSessions.values()],
  });
  const client = makeTestMarimoClient({
    ...options,
    send: (request) =>
      Effect.gen(function* () {
        const before = snapshot();
        const result = yield* send(request);
        switch (request.kind) {
          case "list-sessions":
            return before;
          case "execute": {
            const notebookUri = notebookId(request.notebookUri);
            const existing = serverSessions.get(notebookUri);
            if (existing?.executable === request.executable) return snapshot();
            serverSessions.set(notebookUri, {
              sessionId: kernelSessionId(
                `00000000-0000-4000-8000-${String(nextSessionId++).padStart(12, "0")}`,
              ),
              notebookUri,
              filename: NodePath.basename(request.notebookUri),
              executable: request.executable,
              workingDirectory: request.workingDirectory,
              startedAt: 1,
              status: "idle",
              attached: true,
            });
            return snapshot();
          }
          case "close-session":
            serverSessions.delete(notebookId(request.notebookUri));
            return snapshot();
          case "move-session": {
            const previous = serverSessions.get(
              notebookId(request.notebookUri),
            );
            serverSessions.delete(notebookId(request.notebookUri));
            if (previous !== undefined) {
              const notebookUri = notebookId(request.newNotebookUri);
              serverSessions.set(notebookUri, { ...previous, notebookUri });
            }
            return snapshot();
          }
          case "shutdown-all-sessions":
            serverSessions.clear();
            return snapshot();
        }
        return result;
      }),
  });
  return {
    vscode,
    serverSessions,
    snapshot,
    layer: Layer.empty.pipe(
      Layer.provideMerge(NotebookRuntime.layer),
      Layer.provide(client),
      Layer.provide(TestTelemetryLive),
      Layer.provide(TestPythonExtension.layer),
      Layer.provideMerge(vscode.layer),
    ),
  };
});

it.effect(
  "returns a stable handle that binds the notebook ID",
  Effect.fn(function* () {
    const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
    const { layer, vscode } = yield* makeTestLayer({
      send: (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.as(request.kind === "list-sessions" ? { sessions: [] } : null),
        ),
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const editor = TestVsCode.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      const id = notebookId(editor.notebook.uri.toString());
      yield* vscode.openNotebook(editor.notebook);
      yield* Effect.yieldNow;
      const first = yield* notebooks.forNotebook(id);
      const second = yield* notebooks.forNotebook(id);
      const document = yield* notebooks.forDocument(editor.notebook);

      expect(first).toBe(second);

      yield* document
        .execute({ cells: [] }, "/usr/bin/python")
        .pipe(Effect.orDie);
      yield* first.interrupt.pipe(Effect.orDie);

      assert.deepStrictEqual(yield* Ref.get(requests), [
        {
          kind: "list-sessions",
        },
        {
          kind: "execute",
          notebookUri: id,
          executable: "/usr/bin/python",
          workingDirectory: process.cwd(),
          cells: [],
        },
        {
          kind: "interrupt",
          notebookUri: id,
          kernelSessionId: kernelSessionId(
            "00000000-0000-4000-8000-000000000001",
          ),
        },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "continues handling renderer messages after a pre-kernel interaction",
  Effect.fn(function* () {
    const updateSent =
      yield* Deferred.make<
        Extract<TestCommand, { readonly kind: "update-ui-element" }>
      >();
    const { layer, vscode } = yield* makeTestLayer({
      send: (request) =>
        request.kind === "update-ui-element"
          ? Deferred.succeed(updateSent, request).pipe(Effect.as(null))
          : Effect.succeed(null),
    });

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime;
      const editor = TestVsCode.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.rendererMessaging.ready;

      yield* vscode.rendererMessaging.send(editor, {
        command: "update-ui-element",
        params: { objectIds: ["slider"], values: [1] },
      });
      yield* vscode.rendererMessaging.send(editor, {
        command: "copy-image",
        params: {
          src: "data:image/png;base64,",
          requestId: "renderer-still-alive",
        },
      });
      expect(yield* vscode.rendererMessaging.receive).toMatchObject({
        op: "image-data-result",
        requestId: "renderer-still-alive",
      });

      const document = yield* runtime.forDocument(editor.notebook);
      yield* document.execute({ cells: [] }, "/usr/bin/python");

      yield* vscode.rendererMessaging.send(editor, {
        command: "update-ui-element",
        params: { objectIds: ["slider"], values: [2] },
      });
      expect(yield* Deferred.await(updateSent)).toMatchObject({
        kind: "update-ui-element",
        objectIds: ["slider"],
        values: [2],
      });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not report renderer request interruption as a message failure",
  Effect.fn(function* () {
    const updateStarted = yield* Deferred.make<void>();
    const updateCancelled = yield* Deferred.make<void>();
    const errors: Array<unknown> = [];
    const logger = Logger.make(({ logLevel, message }) => {
      if (logLevel === "Error") errors.push(message);
    });
    const { layer, vscode } = yield* makeTestLayer({
      send: (request) =>
        request.kind === "update-ui-element"
          ? Deferred.succeed(updateStarted, undefined).pipe(
              Effect.andThen(Effect.interrupt),
              Effect.onInterrupt(() =>
                Deferred.succeed(updateCancelled, undefined),
              ),
            )
          : Effect.succeed(null),
    });

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime;
      const editor = TestVsCode.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.rendererMessaging.ready;
      const document = yield* runtime.forDocument(editor.notebook);
      yield* document.execute({ cells: [] }, "/usr/bin/python");

      yield* vscode.rendererMessaging.send(editor, {
        command: "update-ui-element",
        params: { objectIds: ["slider"], values: [1] },
      });
      yield* Deferred.await(updateStarted);
      yield* Effect.yieldNow;
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Logger.layer([logger])))));

    expect(yield* Deferred.isDone(updateCancelled)).toBe(true);
    expect(errors).toEqual([]);
  }),
);

it.effect(
  "keeps captured kernel identity authoritative over request fields",
  Effect.fn(function* () {
    const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
    const { layer, vscode } = yield* makeTestLayer({
      send: (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.as(null),
        ),
    });

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime;
      const editor = TestVsCode.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      const id = notebookId(editor.notebook.uri.toString());
      const activeSessionId = kernelSessionId(
        "00000000-0000-4000-8000-000000000001",
      );
      const foreignIdentity = {
        notebookUri: notebookId("file:///foreign.py"),
        kernelSessionId: kernelSessionId(
          "00000000-0000-4000-8000-000000000002",
        ),
      };

      yield* vscode.openNotebook(editor.notebook);
      yield* Effect.yieldNow;
      const document = yield* runtime.forDocument(editor.notebook);
      yield* document.execute({ cells: [] }, "/usr/bin/python");
      const notebook = yield* runtime.forNotebook(id);

      yield* notebook.updateUIElements({
        ...foreignIdentity,
        objectIds: [],
        values: [],
      });
      yield* notebook.updateModel({
        ...foreignIdentity,
        modelId: "model-1",
        message: { method: "custom", content: {} },
        buffers: [],
      });
      yield* notebook.invokeFunction({
        ...foreignIdentity,
        functionCallId: "call-1",
        namespace: "namespace",
        functionName: "function",
        args: {},
      });
      yield* notebook.deleteCell({
        ...foreignIdentity,
        cellId: cellId("cell-1"),
      });

      const commands = (yield* Ref.get(requests)).filter((request) =>
        [
          "update-ui-element",
          "set-model-value",
          "invoke-function",
          "delete-cell",
        ].includes(request.kind),
      );
      expect(commands.map((request) => request.kind)).toEqual([
        "update-ui-element",
        "set-model-value",
        "invoke-function",
        "delete-cell",
      ]);
      for (const command of commands) {
        expect(command).toMatchObject({
          notebookUri: id,
          kernelSessionId: activeSessionId,
        });
      }
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([false, true])(
  "binds execution before queued kernel mutations without session notifications (replacement=%s)",
  (replacement) =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
      const executionStarted = yield* Deferred.make<void>();
      const releaseExecution = yield* Deferred.make<void>();
      const editor = TestVsCode.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      const id = notebookId(editor.notebook.uri.toString());
      const { layer } = yield* makeTestLayer(
        {
          send: (request) =>
            Effect.gen(function* () {
              yield* Ref.update(calls, (current) => [...current, request]);
              if (
                request.kind === "execute" &&
                request.executable === "/usr/bin/python"
              ) {
                yield* Deferred.succeed(executionStarted, undefined);
                yield* Deferred.await(releaseExecution);
              }
              return request.kind === "list-sessions" ? { sessions: [] } : null;
            }),
        },
        { initialDocuments: [editor.notebook] },
      );

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime;
        const document = yield* runtime.forDocument(editor.notebook);
        if (replacement) {
          yield* document.execute({ cells: [] }, "/old-python");
          yield* Ref.set(calls, []);
        }
        const execution = yield* document
          .execute({ cells: [] }, "/usr/bin/python")
          .pipe(Effect.forkChild);
        yield* Deferred.await(executionStarted);

        const notebook = yield* runtime.forNotebook(id);
        const mutation = yield* notebook
          .updateUIElements({ objectIds: [], values: [] })
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        expect(
          (yield* Ref.get(calls)).some(
            (request) => request.kind === "update-ui-element",
          ),
        ).toBe(false);

        yield* Deferred.succeed(releaseExecution, undefined);
        yield* Fiber.join(execution);
        yield* Fiber.join(mutation);

        const kernelCalls = (yield* Ref.get(calls)).filter(
          (request) =>
            request.kind === "execute" || request.kind === "update-ui-element",
        );
        expect(kernelCalls.map((request) => request.kind)).toEqual([
          "execute",
          "update-ui-element",
        ]);
        expect(kernelCalls.at(-1)).toMatchObject({
          kind: "update-ui-element",
          notebookUri: id,
          kernelSessionId: kernelSessionId(
            replacement
              ? "00000000-0000-4000-8000-000000000002"
              : "00000000-0000-4000-8000-000000000001",
          ),
        });
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each(["close", "move"] as const)(
  "reuses the snapshot from %s instead of querying again",
  (operation) =>
    Effect.gen(function* () {
      let queries = 0;
      const editor = TestVsCode.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      const id = notebookId(editor.notebook.uri.toString());
      const { layer } = yield* makeTestLayer(
        {
          send: (request) =>
            Effect.sync(() => {
              if (request.kind === "list-sessions") queries += 1;
              return null;
            }),
        },
        { initialDocuments: [editor.notebook] },
      );
      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime;
        const document = yield* runtime.forDocument(editor.notebook);
        yield* document.execute({ cells: [] }, "/python");
        const notebook = yield* runtime.forNotebook(id);
        const before = queries;
        switch (operation) {
          case "close":
            yield* notebook.close;
            break;
          case "move":
            yield* runtime.moveSession(id, notebookId(`${id}-renamed.py`));
            break;
        }
        yield* Effect.yieldNow;
        expect(queries - before).toBe(0);
        expect((yield* Effect.flip(notebook.interrupt))._tag).toBe(
          "NoActiveKernelError",
        );
        if (operation === "move") {
          const moved = yield* runtime.forNotebook(
            notebookId(`${id}-renamed.py`),
          );
          yield* moved.interrupt;
        }
      }).pipe(Effect.provide(layer));
    }),
);

it.effect(
  "does not let execution escape its document session",
  Effect.fn(function* () {
    const requestStarted = yield* Deferred.make<void>();
    const releaseRequest = yield* Deferred.make<void>();
    const first = TestVsCode.makeNotebookEditor(
      NodePath.join(process.cwd(), "notebook.py"),
    );
    const id = notebookId(first.notebook.uri.toString());
    const { layer, vscode } = yield* makeTestLayer(
      {
        send: (request) =>
          request.kind === "execute" && request.executable === "/old-python"
            ? Deferred.succeed(requestStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRequest)),
                Effect.as(null),
              )
            : Effect.succeed(
                request.kind === "list-sessions" ? { sessions: [] } : null,
              ),
      },
      { initialDocuments: [first.notebook] },
    );

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime;
      const firstDocument = yield* runtime.forDocument(first.notebook);
      const pending = yield* firstDocument
        .execute({ cells: [] }, "/old-python")
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(requestStarted);

      const replacement = TestVsCode.makeNotebookEditor(first.notebook.uri);
      yield* vscode.openNotebook(replacement.notebook);
      const replacementDocument = yield* runtime
        .forDocument(replacement.notebook)
        .pipe(Effect.retry(Schedule.recurs(100)), Effect.orDie);
      yield* replacementDocument.execute({ cells: [] }, "/new-python");

      yield* Deferred.succeed(releaseRequest, undefined);
      expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
      expect(yield* runtime.getRuntimeSession(id)).toEqual(
        Option.some({
          executable: "/new-python",
          workingDirectory: process.cwd(),
        }),
      );

      const ended = yield* firstDocument
        .execute({ cells: [] }, "/old-python")
        .pipe(Effect.flip);
      expect(ended._tag).toBe("NoActiveKernelError");
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("tracks RuntimeSession until a successful kernel close", () =>
  Effect.acquireUseRelease(
    Effect.sync(() =>
      NodeFs.mkdtempDisposableSync(
        NodePath.join(NodeOs.tmpdir(), "marimo-runtime-session-"),
      ),
    ),
    (temporary) =>
      Effect.gen(function* () {
        const firstRoot = NodePath.join(temporary.path, "first");
        const secondRoot = NodePath.join(temporary.path, "second");
        NodeFs.mkdirSync(firstRoot);
        NodeFs.mkdirSync(secondRoot);
        let configuredRoot = firstRoot;
        const editor = TestVsCode.makeNotebookEditor(
          NodePath.join(temporary.path, "notebook.py"),
        );
        const id = notebookId(editor.notebook.uri.toString());
        const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
        const { layer, vscode } = yield* makeTestLayer(
          {
            send: (request) =>
              Ref.update(requests, (current) => [...current, request]).pipe(
                Effect.as(
                  request.kind === "list-sessions" ? { sessions: [] } : null,
                ),
              ),
          },
          {
            initialDocuments: [editor.notebook],
            workspace: {
              getConfiguration: (section) =>
                Effect.succeed({
                  // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
                  get: <T>(key: string) => {
                    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                    return (
                      section === "marimo" && key === "notebookFileRoot"
                        ? configuredRoot
                        : undefined
                    ) as T;
                  },
                  has: (key: string) =>
                    section === "marimo" && key === "notebookFileRoot",
                  inspect: () => undefined,
                  async update() {},
                }),
            },
          },
        );

        yield* Effect.gen(function* () {
          const runtime = yield* NotebookRuntime;
          yield* Effect.yieldNow;
          const firstDocument = yield* runtime.forDocument(editor.notebook);
          yield* firstDocument.execute({ cells: [] }, "/python-one");

          configuredRoot = secondRoot;
          yield* firstDocument.execute({ cells: [] }, "/python-one");
          expect(yield* runtime.getRuntimeSession(id)).toEqual(
            Option.some({
              executable: "/python-one",
              workingDirectory: firstRoot,
            }),
          );

          yield* vscode.closeNotebook(editor.notebook);
          yield* Effect.yieldNow;
          expect(yield* runtime.getRuntimeSession(id)).toEqual(
            Option.some({
              executable: "/python-one",
              workingDirectory: firstRoot,
            }),
          );

          // Reopening a URI creates a fresh document object; a closed one
          // is never resurrected.
          const reopened = TestVsCode.makeNotebookEditor(
            NodePath.join(temporary.path, "notebook.py"),
          );
          yield* vscode.openNotebook(reopened.notebook);
          yield* Effect.yieldNow;
          const secondDocument = yield* runtime.forDocument(reopened.notebook);
          yield* secondDocument.execute({ cells: [] }, "/python-two");
          const notebook = yield* runtime.forNotebook(id);
          yield* notebook.close;
          expect(Option.isNone(yield* runtime.getRuntimeSession(id))).toBe(
            true,
          );

          configuredRoot = firstRoot;
          yield* secondDocument.execute({ cells: [] }, "/python-two");

          const launches = (yield* Ref.get(requests)).filter(
            (request) => request.kind === "execute",
          );
          expect(launches.map((request) => request.workingDirectory)).toEqual([
            firstRoot,
            firstRoot,
            secondRoot,
            firstRoot,
          ]);
        }).pipe(Effect.provide(layer));
      }),
    (temporary) => Effect.sync(() => temporary.remove()),
  ),
);

it.effect(
  "subscribes to MarimoClient operations once",
  Effect.fn(function* () {
    let subscriptions = 0;
    const { layer } = yield* makeTestLayer({
      // Stream.suspend evaluates once per subscription, so the counter still
      // measures how many times the runtime subscribed to `operations`.
      kernelNotifications: Stream.suspend(() => {
        subscriptions += 1;
        return Stream.never;
      }),
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.forNotebook(notebook);
      yield* notebooks.forNotebook(notebookId("notebook-b"));

      const settledSubscriptions = yield* eventually(
        Effect.sync(() => subscriptions),
        (count) => count === 1,
      );
      expect(settledSubscriptions).toBe(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "owns the selected controller",
  Effect.fn(function* () {
    const { layer } = yield* makeTestLayer();
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: () => Effect.void,
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const handle = yield* notebooks.forNotebook(notebook);

      expect(Option.isNone(yield* handle.getController)).toBe(true);
      yield* notebooks.attachController(notebook, controller);

      expect(yield* handle.getController).toEqual(Option.some(controller));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not report a live kernel from controller selection alone",
  Effect.fn(function* () {
    const { layer, vscode } = yield* makeTestLayer();
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: () => Effect.void,
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* notebooks.attachController(
        notebookId(editor.notebook.uri.toString()),
        controller,
      );

      const contexts = (yield* Ref.get(vscode.executions)).filter(
        (execution) =>
          execution.command === "setContext" &&
          execution.args[0] === "marimo.notebook.hasKernel",
      );
      expect(contexts.at(-1)?.args[1]).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "restores notebook output without starting a kernel",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
    const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
    const presented = yield* Deferred.make<ReadonlyArray<CellOutputReplay>>();
    const replay: CellOutputReplay = {
      kind: "saved",
      notification: {
        op: "cell-op",
        cell_id: cellId("cell-1"),
        status: "idle",
        output: {
          channel: "output",
          mimetype: "text/plain",
          data: "42",
        },
        stale_inputs: true,
      },
    };
    const { layer, vscode } = yield* makeTestLayer(
      {
        send: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as(
              request.kind === "read-notebook-outputs"
                ? { cells: [replay] }
                : null,
            ),
          ),
      },
      { initialDocuments: [editor.notebook] },
    );
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: (_notebook, cells) => Deferred.succeed(presented, cells),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* vscode.openNotebook(editor.notebook);
      yield* Effect.yieldNow;
      const id = notebookId(editor.notebook.uri.toString());
      yield* notebooks.forDocument(editor.notebook);
      yield* notebooks.attachController(id, controller);

      const restored = yield* Deferred.await(presented);
      expect(restored).toEqual([replay]);
      expect(Option.isNone(yield* notebooks.getRuntimeSession(id))).toBe(true);
      const kinds = (yield* Ref.get(requests)).map((request) => request.kind);
      expect(kinds).toContain("read-notebook-outputs");
      expect(kinds).not.toContain("execute");
      expect(kinds).not.toContain("restart-session");
    }).pipe(Effect.provide(layer));
  }),
);

const hasKernelContexts = (vscode: TestVsCode) =>
  Effect.map(Ref.get(vscode.executions), (executions) =>
    executions
      .filter(
        (execution) =>
          execution.command === "setContext" &&
          execution.args[0] === "marimo.notebook.hasKernel",
      )
      .map((execution) => execution.args[1]),
  );

/**
 * Retries until the runtime's forked subscribers have caught up, then gives up
 * and returns the last value so a failing assertion reports it.
 */
const eventually = <A>(
  get: Effect.Effect<A>,
  predicate: (value: A) => boolean,
) =>
  Effect.filterOrFail(get, predicate, () => "not settled yet" as const).pipe(
    Effect.retry(Schedule.recurs(100)),
    Effect.catch(() => get),
  );

it.effect(
  "reports no kernel for an active notebook with no controller",
  Effect.fn(function* () {
    const { layer, vscode } = yield* makeTestLayer();
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

    yield* Effect.gen(function* () {
      yield* NotebookRuntime;
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      const contexts = yield* eventually(
        hasKernelContexts(vscode),
        (values) => values.length > 0,
      );
      expect(contexts.at(-1)).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "reports a live kernel from the server session snapshot",
  Effect.fn(function* () {
    const changes = yield* PubSub.unbounded<ListSessionsResponse>();
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const id = notebookId(editor.notebook.uri.toString());
    const { layer, vscode } = yield* makeTestLayer({
      sessionChanges: Stream.fromPubSub(changes),
    });

    yield* Effect.gen(function* () {
      yield* NotebookRuntime;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* Effect.yieldNow;
      yield* PubSub.publish(changes, {
        generation: 1,
        revision: 2,
        sessions: [
          {
            sessionId: kernelSessionId("00000000-0000-4000-8000-000000000001"),
            notebookUri: id,
            filename: "notebook_mo.py",
            executable: "/usr/bin/python",
            workingDirectory: "/test",
            startedAt: 1,
            status: "idle",
            attached: true,
          },
        ],
      });

      const contexts = yield* eventually(
        hasKernelContexts(vscode),
        (values) => values.at(-1) === true,
      );
      expect(contexts.at(-1)).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "releases a notebook's controller when its document closes",
  Effect.fn(function* () {
    const { layer, vscode } = yield* makeTestLayer();
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const id = notebookId(editor.notebook.uri.toString());
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: () => Effect.void,
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* vscode.openNotebook(editor.notebook);
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* notebooks.attachController(id, controller);
      expect((yield* hasKernelContexts(vscode)).at(-1)).toBe(false);

      yield* Effect.yieldNow;
      yield* vscode.closeNotebook(editor.notebook);

      // Pruning treats a controller as dead once no open notebook selects it,
      // so the runtime must stop handing this one out. Re-resolve the handle
      // each attempt: one captured before the close reads the released state.
      const released = yield* eventually(
        notebooks
          .forNotebook(id)
          .pipe(Effect.flatMap((notebook) => notebook.getController)),
        Option.isNone,
      );
      expect(Option.isNone(released)).toBe(true);
      expect((yield* hasKernelContexts(vscode)).at(-1)).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "keeps processing session changes while another notebook is busy",
  Effect.fn(function* () {
    const changes = yield* PubSub.unbounded<ListSessionsResponse>();
    const executionStarted = yield* Deferred.make<void>();
    const releaseExecution = yield* Deferred.make<void>();
    const first = TestVsCode.makeNotebookEditor(
      NodePath.join(process.cwd(), "busy.py"),
    );
    const second = TestVsCode.makeNotebookEditor(
      NodePath.join(process.cwd(), "other.py"),
    );
    const firstId = notebookId(first.notebook.uri.toString());
    const secondId = notebookId(second.notebook.uri.toString());
    const { layer, vscode, serverSessions, snapshot } = yield* makeTestLayer(
      {
        sessionChanges: Stream.fromPubSub(changes),
        send: (request) =>
          request.kind === "execute" && request.executable === "/replacement"
            ? Deferred.succeed(executionStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseExecution)),
                Effect.as(null),
              )
            : Effect.succeed(null),
      },
      { initialDocuments: [first.notebook, second.notebook] },
    );
    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime;
      const firstDocument = yield* runtime.forDocument(first.notebook);
      const secondDocument = yield* runtime.forDocument(second.notebook);
      yield* firstDocument.execute({ cells: [] }, "/python");
      yield* secondDocument.execute({ cells: [] }, "/python");
      yield* vscode.setActiveNotebookEditor(Option.some(second));
      yield* eventually(
        hasKernelContexts(vscode),
        (values) => values.at(-1) === true,
      );

      const execution = yield* firstDocument
        .execute({ cells: [] }, "/replacement")
        .pipe(Effect.forkChild);
      yield* Deferred.await(executionStarted);
      serverSessions.delete(firstId);
      yield* PubSub.publish(changes, snapshot());
      yield* eventually(runtime.getRuntimeSession(firstId), Option.isNone);
      // This second change must reach the active editor before the busy
      // notebook's command returns, even though its first change is still queued.
      serverSessions.delete(secondId);
      yield* PubSub.publish(changes, snapshot());
      const contexts = yield* eventually(
        hasKernelContexts(vscode),
        (values) => values.at(-1) === false,
      );
      expect(contexts.at(-1)).toBe(false);
      const other = yield* runtime.forNotebook(secondId);
      expect((yield* Effect.flip(other.interrupt))._tag).toBe(
        "NoActiveKernelError",
      );

      yield* Deferred.succeed(releaseExecution, undefined);
      yield* Fiber.join(execution);
      // Earlier queued snapshots must not erase the replacement accepted above.
      const busy = yield* runtime.forNotebook(firstId);
      yield* busy.interrupt;
    }).pipe(Effect.provide(layer));
  }),
);
