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
  Option,
  PubSub,
  Ref,
  Schedule,
  Stream,
} from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  cellId,
  kernelSessionId,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import type { CellOutputReplay } from "../../schemas/Models.gen.ts";
import type { MarimoApiCall } from "../../types.ts";
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
  const execute = options.execute ?? (() => Effect.succeed(null));
  const client = makeTestMarimoClient({
    ...options,
    execute: (request) =>
      Effect.gen(function* () {
        const result = yield* execute(request);
        switch (request.method) {
          case "list-sessions":
            return { sessions: [...serverSessions.values()] };
          case "execute-cells": {
            const notebookUri = notebookId(request.params.notebookUri);
            serverSessions.set(notebookUri, {
              sessionId: kernelSessionId(
                "00000000-0000-4000-8000-000000000001",
              ),
              notebookUri,
              filename: NodePath.basename(request.params.notebookUri),
              executable: request.params.executable,
              workingDirectory: request.params.workingDirectory,
              startedAt: 1,
              status: "idle",
              attached: true,
            });
            break;
          }
          case "close-session":
            serverSessions.delete(notebookId(request.params.notebookUri));
            break;
          case "shutdown-all-sessions":
            serverSessions.clear();
            break;
        }
        return result;
      }),
  });
  return {
    vscode,
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
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const { layer, vscode } = yield* makeTestLayer({
      execute: (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.as(
            request.method === "list-sessions" ? { sessions: [] } : null,
          ),
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
        .executeCells({ cellIds: [], codes: [] }, "/usr/bin/python")
        .pipe(Effect.orDie);
      yield* first.interrupt.pipe(Effect.orDie);

      assert.deepStrictEqual(yield* Ref.get(requests), [
        {
          method: "list-sessions",
          params: {},
        },
        {
          method: "execute-cells",
          params: {
            notebookUri: id,
            executable: "/usr/bin/python",
            workingDirectory: process.cwd(),
            inner: { cellIds: [], codes: [] },
          },
        },
        {
          method: "list-sessions",
          params: {},
        },
        {
          method: "interrupt",
          params: {
            notebookUri: id,
            inner: {
              sessionId: kernelSessionId(
                "00000000-0000-4000-8000-000000000001",
              ),
            },
          },
        },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "orders kernel mutations behind admitted notebook work",
  Effect.fn(function* () {
    const calls = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const secondExecutionStarted = yield* Deferred.make<void>();
    const releaseSecondExecution = yield* Deferred.make<void>();
    let executionCount = 0;
    const editor = TestVsCode.makeNotebookEditor(
      NodePath.join(process.cwd(), "notebook.py"),
    );
    const id = notebookId(editor.notebook.uri.toString());
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) =>
          Effect.gen(function* () {
            yield* Ref.update(calls, (current) => [...current, request]);
            if (request.method === "execute-cells") {
              executionCount += 1;
              if (executionCount === 2) {
                yield* Deferred.succeed(secondExecutionStarted, undefined);
                yield* Deferred.await(releaseSecondExecution);
              }
            }
            return request.method === "list-sessions" ? { sessions: [] } : null;
          }),
      },
      { initialDocuments: [editor.notebook] },
    );

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime;
      const document = yield* runtime.forDocument(editor.notebook);
      yield* document.executeCells(
        { cellIds: [], codes: [] },
        "/usr/bin/python",
      );

      const execution = yield* document
        .executeCells({ cellIds: [], codes: [] }, "/usr/bin/python")
        .pipe(Effect.forkChild);
      yield* Deferred.await(secondExecutionStarted);

      const notebook = yield* runtime.forNotebook(id);
      const mutation = yield* notebook
        .updateUIElements({ objectIds: [], values: [] })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(
        (yield* Ref.get(calls)).some(
          (request) => request.method === "update-ui-element",
        ),
      ).toBe(false);

      yield* Deferred.succeed(releaseSecondExecution, undefined);
      yield* Fiber.join(execution);
      yield* Fiber.join(mutation);

      const kernelCalls = (yield* Ref.get(calls)).filter(
        (request) =>
          request.method === "execute-cells" ||
          request.method === "update-ui-element",
      );
      expect(kernelCalls.map((request) => request.method)).toEqual([
        "execute-cells",
        "execute-cells",
        "update-ui-element",
      ]);
      expect(kernelCalls.at(-1)).toMatchObject({
        method: "update-ui-element",
        params: {
          notebookUri: id,
          sessionId: kernelSessionId("00000000-0000-4000-8000-000000000001"),
        },
      });
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
        execute: (request) =>
          request.method === "execute-cells" &&
          request.params.executable === "/old-python"
            ? Deferred.succeed(requestStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRequest)),
                Effect.as(null),
              )
            : Effect.succeed(
                request.method === "list-sessions" ? { sessions: [] } : null,
              ),
      },
      { initialDocuments: [first.notebook] },
    );

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime;
      const firstDocument = yield* runtime.forDocument(first.notebook);
      const pending = yield* firstDocument
        .executeCells({ cellIds: [], codes: [] }, "/old-python")
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(requestStarted);

      const replacement = TestVsCode.makeNotebookEditor(first.notebook.uri);
      yield* vscode.openNotebook(replacement.notebook);
      const replacementDocument = yield* runtime
        .forDocument(replacement.notebook)
        .pipe(Effect.retry(Schedule.recurs(100)), Effect.orDie);
      yield* replacementDocument.executeCells(
        { cellIds: [], codes: [] },
        "/new-python",
      );

      yield* Deferred.succeed(releaseRequest, undefined);
      expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
      expect(yield* runtime.getRuntimeSession(id)).toEqual(
        Option.some({
          executable: "/new-python",
          workingDirectory: process.cwd(),
        }),
      );

      const ended = yield* firstDocument
        .executeCells({ cellIds: [], codes: [] }, "/old-python")
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
        const requests = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
        const { layer, vscode } = yield* makeTestLayer(
          {
            execute: (request) =>
              Ref.update(requests, (current) => [...current, request]).pipe(
                Effect.as(
                  request.method === "list-sessions" ? { sessions: [] } : null,
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
          yield* firstDocument.executeCells(
            { cellIds: [], codes: [] },
            "/python-one",
          );

          configuredRoot = secondRoot;
          yield* firstDocument.executeCells(
            { cellIds: [], codes: [] },
            "/python-one",
          );
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
          yield* secondDocument.executeCells(
            { cellIds: [], codes: [] },
            "/python-two",
          );
          const notebook = yield* runtime.forNotebook(id);
          yield* notebook.close;
          expect(Option.isNone(yield* runtime.getRuntimeSession(id))).toBe(
            true,
          );

          configuredRoot = firstRoot;
          yield* secondDocument.executeCells(
            { cellIds: [], codes: [] },
            "/python-two",
          );

          const launches = (yield* Ref.get(requests)).filter(
            (request) => request.method === "execute-cells",
          );
          expect(
            launches.map((request) => request.params.workingDirectory),
          ).toEqual([firstRoot, firstRoot, secondRoot, firstRoot]);
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
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
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
        execute: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as(
              request.method === "read-notebook-outputs"
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
      const methods = (yield* Ref.get(requests)).map(
        (request) => request.method,
      );
      expect(methods).toContain("read-notebook-outputs");
      expect(methods).not.toContain("execute-cells");
      expect(methods).not.toContain("restart-session");
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
    const changes = yield* PubSub.unbounded<{
      sessions: ReadonlyArray<{
        sessionId: ReturnType<typeof kernelSessionId>;
        notebookUri: ReturnType<typeof notebookId>;
        filename: string;
        executable: string;
        workingDirectory: string;
        startedAt: number;
        status: "idle";
        attached: boolean;
      }>;
    }>();
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
