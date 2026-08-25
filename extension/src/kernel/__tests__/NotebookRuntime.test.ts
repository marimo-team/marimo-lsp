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
import { kernelSessionId, notebookId } from "../../lib/__tests__/branded.ts";
import {
  MarimoNotebookCell,
  NotebookCellId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { KernelNotification, MarimoApiCall } from "../../types.ts";
import type { CellCommand } from "../CellRunReducer.ts";
import {
  type NotebookController,
  NotebookRuntime,
} from "../NotebookRuntime.ts";

const notebook = notebookId("notebook-a");

interface TestServerSession {
  readonly sessionId: ReturnType<typeof kernelSessionId>;
  readonly notebookUri: ReturnType<typeof notebookId>;
  readonly filename: string;
  readonly executable: string;
  readonly workingDirectory: string;
  readonly startedAt: number;
  readonly status: "idle";
  readonly attached: boolean;
}

const makeTestLayer = Effect.fn(function* (
  options: Parameters<typeof makeTestMarimoClient>[0] = {},
  vscodeOptions: Parameters<typeof TestVsCode.make>[0] = {},
  initialServerSessions: ReadonlyArray<TestServerSession> = [],
) {
  const vscode = yield* TestVsCode.make(vscodeOptions);
  const serverSessions = new Map<
    ReturnType<typeof notebookId>,
    TestServerSession
  >();
  for (const session of initialServerSessions) {
    serverSessions.set(session.notebookUri, session);
  }
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
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const id = notebookId(editor.notebook.uri.toString());
    const { layer } = yield* makeTestLayer(
      {},
      { initialDocuments: [editor.notebook] },
    );
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const handle = yield* notebooks.forNotebook(id);

      expect(Option.isNone(yield* handle.getController)).toBe(true);
      yield* notebooks.attachController(editor.notebook, controller);

      expect(yield* handle.getController).toEqual(Option.some(controller));
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "hydrates the exact selected document without starting a kernel",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
      data: {
        cells: [
          {
            kind: 1,
            value: "answer = 42",
            languageId: "python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    });
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const presented = yield* Deferred.make<void>();
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.as(
              request.method === "read-session-outputs"
                ? {
                    notifications: [
                      {
                        op: "cell-op",
                        cell_id: NotebookCellId("cell-1"),
                        output: {
                          channel: "output",
                          mimetype: "text/plain",
                          data: "saved",
                        },
                        console: [],
                        stale_inputs: true,
                      },
                    ],
                  }
                : null,
            ),
          ),
      },
      { initialDocuments: [editor.notebook] },
    );
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: (notifications, _version, onPresented) =>
          Effect.forEach(
            notifications,
            (notification) => onPresented(notification),
            { discard: true },
          ).pipe(Effect.andThen(Deferred.succeed(presented, undefined))),
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, controller);
      yield* Deferred.await(presented);

      const calls = yield* Ref.get(requests);
      expect(
        calls.some((request) => request.method === "read-session-outputs"),
      ).toBe(true);
      expect(calls.some((request) => request.method === "execute-cells")).toBe(
        false,
      );
      expect(
        calls.some((request) => request.method === "restart-session"),
      ).toBe(false);
      expect(
        Option.isNone(
          yield* notebooks.getRuntimeSession(
            notebookId(editor.notebook.uri.toString()),
          ),
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "orders a live completion behind in-flight replay",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
      data: {
        cells: [
          {
            kind: 1,
            value: "answer = 42",
            languageId: "python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    });
    const id = notebookId(editor.notebook.uri.toString());
    const sessionId = kernelSessionId("00000000-0000-4000-8000-000000000001");
    const requested = yield* Deferred.make<void>();
    const response = yield* Deferred.make<{
      notifications: KernelNotification["notification"][];
    }>();
    const completed = yield* Deferred.make<void>();
    const operations = yield* PubSub.unbounded<KernelNotification>();
    const commands: CellCommand[] = [];
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) => {
          if (request.method !== "read-session-outputs") {
            return Effect.succeed(null);
          }
          return Deferred.succeed(requested, undefined).pipe(
            Effect.andThen(Deferred.await(response)),
          );
        },
        kernelNotifications: Stream.fromPubSub(operations),
      },
      { initialDocuments: [editor.notebook] },
      [
        {
          sessionId,
          notebookUri: id,
          filename: "notebook_mo.py",
          executable: "/usr/bin/python",
          workingDirectory: process.cwd(),
          startedAt: 1,
          status: "idle",
          attached: true,
        },
      ],
    );
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      presentation: () => ({
        present: (_cell, command) =>
          Effect.sync(() => {
            commands.push(command);
          }).pipe(
            Effect.andThen(
              command._tag === "CloseRun"
                ? Deferred.succeed(completed, undefined)
                : Effect.void,
            ),
          ),
        presentSavedOutputs: (notifications, _version, onPresented) =>
          Effect.forEach(
            notifications,
            (notification) => onPresented(notification),
            { discard: true },
          ),
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, controller);
      yield* Deferred.await(requested);
      yield* PubSub.publish(operations, {
        notebookUri: id,
        sessionId,
        notification: {
          op: "cell-op",
          cell_id: NotebookCellId("cell-1"),
          status: "idle",
          run_id: "surviving-run",
          output: {
            channel: "output",
            mimetype: "text/plain",
            data: "finished",
          },
        },
      });
      yield* Deferred.succeed(response, {
        notifications: [
          {
            op: "cell-op",
            cell_id: NotebookCellId("cell-1"),
            status: "running",
            run_id: "surviving-run",
            stale_inputs: false,
          },
        ],
      });
      yield* Deferred.await(completed);

      expect(commands.map((command) => command._tag)).toEqual([
        "SetDiagnostic",
        "OpenRun",
        "StartRun",
        "RenderOutputs",
        "RenderOutputs",
        "SetDiagnostic",
        "CloseRun",
      ]);
      expect(
        commands.find(
          (command) => command._tag === "RenderOutputs" && command.final,
        ),
      ).toMatchObject({ state: { output: { data: "finished" } } });
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not hold other notebooks behind hydration",
  Effect.fn(function* () {
    const first = TestVsCode.makeNotebookEditor("/test/first_mo.py");
    const second = TestVsCode.makeNotebookEditor("/test/second_mo.py", {
      data: {
        cells: [
          {
            kind: 1,
            value: "answer = 0",
            languageId: "python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    });
    const firstId = notebookId(first.notebook.uri.toString());
    const secondId = notebookId(second.notebook.uri.toString());
    const sessionId = kernelSessionId("00000000-0000-4000-8000-000000000001");
    const requested = yield* Deferred.make<void>();
    const applied = yield* Deferred.make<void>();
    const operations = yield* PubSub.unbounded<KernelNotification>();
    const sessions = [firstId, secondId].map(
      (notebookUri): TestServerSession => ({
        sessionId,
        notebookUri,
        filename: NodePath.basename(notebookUri),
        executable: "/usr/bin/python",
        workingDirectory: process.cwd(),
        startedAt: 1,
        status: "idle",
        attached: true,
      }),
    );
    const { layer, vscode } = yield* makeTestLayer(
      {
        execute: (request) =>
          request.method === "read-session-outputs" &&
          request.params.notebookUri === firstId
            ? Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Effect.never),
              )
            : Effect.succeed(
                request.method === "read-session-outputs"
                  ? { notifications: [] }
                  : null,
              ),
        kernelNotifications: Stream.fromPubSub(operations),
      },
      {
        initialDocuments: [first.notebook, second.notebook],
        workspace: {
          applyEdit: () =>
            Deferred.succeed(applied, undefined).pipe(Effect.as(true)),
        },
      },
      sessions,
    );
    const controller: NotebookController = {
      id: "first",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(first.notebook, controller);
      yield* Deferred.await(requested);
      yield* vscode.setActiveNotebookEditor(Option.some(second));
      yield* PubSub.publish(operations, {
        notebookUri: secondId,
        sessionId,
        notification: {
          op: "notebook-document-transaction",
          transaction: {
            changes: [
              {
                type: "set-code",
                cellId: NotebookCellId("cell-1"),
                code: "answer = 42",
              },
            ],
            source: "code-mode",
            version: 1,
          },
        },
      });
      yield* Deferred.await(applied);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "interrupts hydration when the controller changes",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const requested = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let reads = 0;
    let presented = false;
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) => {
          if (request.method !== "read-session-outputs") {
            return Effect.succeed(null);
          }
          reads += 1;
          return reads === 1
            ? Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              )
            : Effect.succeed({ notifications: [] });
        },
      },
      { initialDocuments: [editor.notebook] },
    );
    const first: NotebookController = {
      id: "first",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () =>
          Effect.sync(() => {
            presented = true;
          }),
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };
    const second: NotebookController = {
      ...first,
      id: "second",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, first);
      yield* Deferred.await(requested);
      yield* notebooks.attachController(editor.notebook, second);
      yield* Deferred.await(interrupted);

      expect(presented).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not present a read from an older notebook version",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const requested = yield* Deferred.make<void>();
    const response = yield* Deferred.make<{
      notifications: Array<{
        op: string;
        cell_id: ReturnType<typeof NotebookCellId>;
      }>;
    }>();
    let reads = 0;
    let presented = false;
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) => {
          if (request.method !== "read-session-outputs") {
            return Effect.succeed(null);
          }
          reads += 1;
          return reads === 1
            ? Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Deferred.await(response)),
              )
            : Effect.succeed({ notifications: [] });
        },
      },
      { initialDocuments: [editor.notebook] },
    );
    const first: NotebookController = {
      id: "first",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () =>
          Effect.sync(() => {
            presented = true;
          }),
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };
    const second: NotebookController = {
      ...first,
      id: "second",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, first);
      yield* Deferred.await(requested);
      Reflect.set(editor.notebook, "version", editor.notebook.version + 1);
      yield* Deferred.succeed(response, {
        notifications: [
          {
            op: "cell-op",
            cell_id: NotebookCellId("cell-1"),
          },
        ],
      });
      yield* notebooks.attachController(editor.notebook, second);

      expect(presented).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "interrupts an admitted presentation before its next cell",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
      data: {
        cells: ["cell-1", "cell-2"].map((stableId) => ({
          kind: 1,
          value: stableId,
          languageId: "python",
          metadata: MarimoNotebookCell.createMetadata({
            marimoRuntime: { stableId },
          }),
        })),
      },
    });
    const firstPresented = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    const presented: NotebookCellId[] = [];
    let reads = 0;
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) => {
          if (request.method !== "read-session-outputs") {
            return Effect.succeed(null);
          }
          reads += 1;
          return Effect.succeed({
            notifications:
              reads === 1
                ? [
                    {
                      op: "cell-op",
                      cell_id: NotebookCellId("cell-1"),
                      stale_inputs: true,
                    },
                    {
                      op: "cell-op",
                      cell_id: NotebookCellId("cell-2"),
                      stale_inputs: true,
                    },
                  ]
                : [],
          });
        },
      },
      { initialDocuments: [editor.notebook] },
    );
    const first: NotebookController = {
      id: "first",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: (notifications, _version, onPresented) =>
          Effect.gen(function* () {
            const firstNotification = notifications[0];
            if (firstNotification !== undefined) {
              const cellId = NotebookCellId(firstNotification.cell_id);
              presented.push(cellId);
              yield* onPresented(firstNotification);
            }
            yield* Deferred.succeed(firstPresented, undefined);
            return yield* Effect.never;
          }).pipe(Effect.ensuring(Deferred.succeed(interrupted, undefined))),
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };
    const second: NotebookController = {
      ...first,
      id: "second",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, first);
      yield* Deferred.await(firstPresented);
      yield* notebooks.attachController(editor.notebook, second);
      yield* Deferred.await(interrupted);

      expect(presented).toEqual([NotebookCellId("cell-1")]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "interrupts hydration when the document closes",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const requested = yield* Deferred.make<void>();
    const interrupted = yield* Deferred.make<void>();
    let presented = false;
    const { layer, vscode } = yield* makeTestLayer(
      {
        execute: (request) =>
          request.method === "read-session-outputs"
            ? Deferred.succeed(requested, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(interrupted, undefined)),
              )
            : Effect.succeed(null),
      },
      { initialDocuments: [editor.notebook] },
    );
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () =>
          Effect.sync(() => {
            presented = true;
          }),
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, controller);
      yield* Deferred.await(requested);
      yield* vscode.closeNotebook(editor.notebook);
      yield* Deferred.await(interrupted);

      expect(presented).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "waits for hydration before executing cells",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor(
      NodePath.join(process.cwd(), "notebook_mo.py"),
    );
    const requested = yield* Deferred.make<void>();
    const response = yield* Deferred.make<{ notifications: never[] }>();
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.andThen(
              request.method === "read-session-outputs"
                ? Deferred.succeed(requested, undefined).pipe(
                    Effect.andThen(Deferred.await(response)),
                  )
                : Effect.succeed(null),
            ),
          ),
      },
      { initialDocuments: [editor.notebook] },
    );
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, controller);
      yield* Deferred.await(requested);
      const handle = yield* notebooks.forDocument(editor.notebook);
      const execution = yield* handle
        .executeCells({ cellIds: [], codes: [] }, "/usr/bin/python")
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(
        (yield* Ref.get(requests)).some(
          (request) => request.method === "execute-cells",
        ),
      ).toBe(false);

      yield* Deferred.succeed(response, { notifications: [] });
      yield* Fiber.join(execution);
      expect(
        (yield* Ref.get(requests)).some(
          (request) => request.method === "execute-cells",
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "waits for replacement hydration during a controller handoff",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor(
      NodePath.join(process.cwd(), "notebook_mo.py"),
    );
    const firstRequested = yield* Deferred.make<void>();
    const firstInterrupted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    const secondRequested = yield* Deferred.make<void>();
    const secondResponse = yield* Deferred.make<{ notifications: never[] }>();
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiCall>>([]);
    let reads = 0;
    const { layer } = yield* makeTestLayer(
      {
        execute: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.andThen(
              request.method !== "read-session-outputs"
                ? Effect.succeed(null)
                : ++reads === 1
                  ? Deferred.succeed(firstRequested, undefined).pipe(
                      Effect.andThen(Effect.never),
                      Effect.ensuring(
                        Deferred.succeed(firstInterrupted, undefined).pipe(
                          Effect.andThen(Deferred.await(releaseFirst)),
                        ),
                      ),
                    )
                  : Deferred.succeed(secondRequested, undefined).pipe(
                      Effect.andThen(Deferred.await(secondResponse)),
                    ),
            ),
          ),
      },
      { initialDocuments: [editor.notebook] },
    );
    const first: NotebookController = {
      id: "first",
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };
    const second: NotebookController = { ...first, id: "second" };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* notebooks.attachController(editor.notebook, first);
      yield* Deferred.await(firstRequested);

      const handoff = yield* notebooks
        .attachController(editor.notebook, second)
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstInterrupted);

      const handle = yield* notebooks.forDocument(editor.notebook);
      const execution = yield* handle
        .executeCells({ cellIds: [], codes: [] }, "/usr/bin/python")
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(
        (yield* Ref.get(requests)).some(
          (request) => request.method === "execute-cells",
        ),
      ).toBe(false);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondRequested);
      expect(
        (yield* Ref.get(requests)).some(
          (request) => request.method === "execute-cells",
        ),
      ).toBe(false);

      yield* Deferred.succeed(secondResponse, { notifications: [] });
      yield* Fiber.join(handoff);
      yield* Fiber.join(execution);
      expect(
        (yield* Ref.get(requests)).some(
          (request) => request.method === "execute-cells",
        ),
      ).toBe(true);
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
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* notebooks.attachController(editor.notebook, controller);

      const contexts = (yield* Ref.get(vscode.executions)).filter(
        (execution) =>
          execution.command === "setContext" &&
          execution.args[0] === "marimo.notebook.hasKernel",
      );
      expect(contexts.at(-1)?.args[1]).toBe(false);
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
      presentation: () => ({
        present: () => Effect.void,
        presentSavedOutputs: () => Effect.void,
      }),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* vscode.openNotebook(editor.notebook);
      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* notebooks.attachController(editor.notebook, controller);
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
