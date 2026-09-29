import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
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
  Stream,
} from "effect";

import * as NotebookRuntime from "../../src/kernel/NotebookRuntime.ts";
import * as NotebookDocumentSessions from "../../src/notebook/NotebookDocumentSessions.ts";
import * as NotebookEditorRegistry from "../../src/notebook/NotebookEditorRegistry.ts";
import * as LiveSessions from "../../src/panel/sessions/LiveSessions.ts";
import type {
  CellOutputReplay,
  ListSessionsResponse,
} from "../../src/schemas/Models.gen.ts";
import * as MarimoClientTest from "../fake/MarimoClient.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { cellId, kernelSessionId, notebookId } from "../lib/branded.ts";
import * as EffectTest from "../lib/EffectTest.ts";
import * as NotebookRuntimeHarness from "./notebookRuntimeHarness.ts";

const notebook = notebookId("notebook-a");
const it = EffectTest.make(Layer.empty);

const makeTestLayer = (
  options: MarimoClientTest.Options = {},
  vscodeOptions: VsCodeTest.Options = {},
  vscodeBehavior: VsCodeTest.Behavior = {},
) => {
  const vscodeLayer = VsCodeTest.layerWith(vscodeOptions, vscodeBehavior);
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
  const client = MarimoClientTest.layerWith({
    ...options,
    send: (request, commands) =>
      Effect.gen(function* () {
        const before = snapshot();
        const result = yield* send(request, commands);
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
    serverSessions,
    snapshot,
    layer: Layer.empty.pipe(
      Layer.provideMerge(NotebookRuntime.defaultLayer),
      Layer.provideMerge(NotebookDocumentSessions.layer),
      Layer.provideMerge(NotebookEditorRegistry.layer),
      Layer.provideMerge(LiveSessions.layer),
      Layer.provide(client),
      Layer.provide(TelemetryTest.layer),
      Layer.provide(PythonExtensionTest.layer),
      Layer.provideMerge(vscodeLayer),
    ),
  };
};

it.effect(
  "returns a stable handle that binds the notebook ID",
  Effect.fn(function* () {
    const requests = yield* Ref.make<ReadonlyArray<MarimoClientTest.Command>>(
      [],
    );
    const { layer } = makeTestLayer({
      send: (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.as(request.kind === "list-sessions" ? { sessions: [] } : null),
        ),
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime.Service;
      const editor = VsCodeTest.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      const id = notebookId(editor.notebook.uri.toString());
      yield* NotebookRuntimeHarness.open(editor);
      const first = yield* notebooks.forNotebook(id);
      const second = yield* notebooks.forNotebook(id);
      const document = yield* notebooks.forDocument(editor.notebook);

      Vitest.expect(first).toBe(second);

      yield* document
        .execute({ cells: [] }, "/usr/bin/python")
        .pipe(Effect.orDie);
      yield* first.interrupt.pipe(Effect.orDie);

      Vitest.assert.deepStrictEqual(yield* Ref.get(requests), [
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
        Extract<
          MarimoClientTest.Command,
          { readonly kind: "update-ui-element" }
        >
      >();
    const { layer } = makeTestLayer({
      send: (request) =>
        request.kind === "update-ui-element"
          ? Deferred.succeed(updateSent, request).pipe(Effect.as(null))
          : Effect.succeed(null),
    });

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime.Service;
      const vscode = yield* VsCodeTest.Service;
      const editor = VsCodeTest.makeNotebookEditor(
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
      Vitest.expect(yield* vscode.rendererMessaging.receive).toMatchObject({
        op: "image-data-result",
        requestId: "renderer-still-alive",
      });

      const document = yield* runtime.forDocument(editor.notebook);
      yield* document.execute({ cells: [] }, "/usr/bin/python");

      yield* vscode.rendererMessaging.send(editor, {
        command: "update-ui-element",
        params: { objectIds: ["slider"], values: [2] },
      });
      Vitest.expect(yield* Deferred.await(updateSent)).toMatchObject({
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
    const { layer } = makeTestLayer({
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
      const runtime = yield* NotebookRuntime.Service;
      const vscode = yield* VsCodeTest.Service;
      const editor = VsCodeTest.makeNotebookEditor(
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
      yield* Deferred.await(updateCancelled);
    }).pipe(Effect.provide(layer.pipe(Layer.provide(Logger.layer([logger])))));

    Vitest.expect(yield* Deferred.isDone(updateCancelled)).toBe(true);
    Vitest.expect(errors).toEqual([]);
  }),
);

it.effect(
  "keeps captured kernel identity authoritative over request fields",
  Effect.fn(function* () {
    const requests = yield* Ref.make<ReadonlyArray<MarimoClientTest.Command>>(
      [],
    );
    const { layer } = makeTestLayer({
      send: (request) =>
        Ref.update(requests, (current) => [...current, request]).pipe(
          Effect.as(null),
        ),
    });

    yield* Effect.gen(function* () {
      const runtime = yield* NotebookRuntime.Service;
      const editor = VsCodeTest.makeNotebookEditor(
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

      yield* NotebookRuntimeHarness.open(editor);
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
      Vitest.expect(commands.map((request) => request.kind)).toEqual([
        "update-ui-element",
        "set-model-value",
        "invoke-function",
        "delete-cell",
      ]);
      for (const command of commands) {
        Vitest.expect(command).toMatchObject({
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
      const calls = yield* Ref.make<ReadonlyArray<MarimoClientTest.Command>>(
        [],
      );
      const executionStarted = yield* Deferred.make<void>();
      const releaseExecution = yield* Deferred.make<void>();
      const editor = VsCodeTest.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      const id = notebookId(editor.notebook.uri.toString());
      const { layer } = makeTestLayer(
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
        const runtime = yield* NotebookRuntime.Service;
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
        const progress = yield* runtime.subscribeInputProgress;
        const request = { objectIds: [], values: [] };
        const mutation = yield* notebook
          .updateUIElements(request)
          .pipe(Effect.forkChild);
        yield* progress.pipe(
          Stream.filter(
            (event) =>
              event._tag === "KernelMutationQueued" &&
              event.request === request,
          ),
          Stream.runHead,
        );
        Vitest.expect(
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
        Vitest.expect(kernelCalls.map((request) => request.kind)).toEqual([
          "execute",
          "update-ui-element",
        ]);
        Vitest.expect(kernelCalls.at(-1)).toMatchObject({
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
      const editor = VsCodeTest.makeNotebookEditor(
        NodePath.join(process.cwd(), "notebook.py"),
      );
      const id = notebookId(editor.notebook.uri.toString());
      const { layer } = makeTestLayer(
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
        const runtime = yield* NotebookRuntime.Service;
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
        Vitest.expect(queries - before).toBe(0);
        Vitest.expect((yield* Effect.flip(notebook.interrupt))._tag).toBe(
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
    const first = VsCodeTest.makeNotebookEditor(
      NodePath.join(process.cwd(), "notebook.py"),
    );
    const id = notebookId(first.notebook.uri.toString());
    const { layer } = makeTestLayer(
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
      const runtime = yield* NotebookRuntime.Service;
      const firstDocument = yield* runtime.forDocument(first.notebook);
      const pending = yield* firstDocument
        .execute({ cells: [] }, "/old-python")
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(requestStarted);

      const replacement = VsCodeTest.makeNotebookEditor(first.notebook.uri);
      yield* NotebookRuntimeHarness.open(replacement);
      const replacementDocument = yield* runtime.forDocument(
        replacement.notebook,
      );
      yield* replacementDocument.execute({ cells: [] }, "/new-python");

      yield* Deferred.succeed(releaseRequest, undefined);
      Vitest.expect(Exit.isFailure(yield* Fiber.join(pending))).toBe(true);
      Vitest.expect(yield* runtime.getRuntimeSession(id)).toEqual(
        Option.some({
          executable: "/new-python",
          workingDirectory: process.cwd(),
        }),
      );

      const ended = yield* firstDocument
        .execute({ cells: [] }, "/old-python")
        .pipe(Effect.flip);
      Vitest.expect(ended._tag).toBe("NoActiveKernelError");
    }).pipe(Effect.provide(layer));
  }),
);

it.live("tracks RuntimeSession until a successful kernel close", () =>
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
        const editor = VsCodeTest.makeNotebookEditor(
          NodePath.join(temporary.path, "notebook.py"),
        );
        const id = notebookId(editor.notebook.uri.toString());
        const requests = yield* Ref.make<
          ReadonlyArray<MarimoClientTest.Command>
        >([]);
        const { layer } = makeTestLayer(
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
          },
          {
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
          const runtime = yield* NotebookRuntime.Service;
          yield* NotebookRuntimeHarness.activate(editor);
          const firstDocument = yield* runtime.forDocument(editor.notebook);
          yield* firstDocument.execute({ cells: [] }, "/python-one");

          configuredRoot = secondRoot;
          yield* firstDocument.execute({ cells: [] }, "/python-one");
          Vitest.expect(yield* runtime.getRuntimeSession(id)).toEqual(
            Option.some({
              executable: "/python-one",
              workingDirectory: firstRoot,
            }),
          );

          yield* NotebookRuntimeHarness.close(editor.notebook);
          Vitest.expect(yield* runtime.getRuntimeSession(id)).toEqual(
            Option.some({
              executable: "/python-one",
              workingDirectory: firstRoot,
            }),
          );

          // Reopening a URI creates a fresh document object; a closed one
          // is never resurrected.
          const reopened = VsCodeTest.makeNotebookEditor(
            NodePath.join(temporary.path, "notebook.py"),
          );
          yield* NotebookRuntimeHarness.open(reopened);
          const secondDocument = yield* runtime.forDocument(reopened.notebook);
          yield* secondDocument.execute({ cells: [] }, "/python-two");
          const notebook = yield* runtime.forNotebook(id);
          yield* notebook.close;
          Vitest.expect(
            Option.isNone(yield* runtime.getRuntimeSession(id)),
          ).toBe(true);

          configuredRoot = firstRoot;
          yield* secondDocument.execute({ cells: [] }, "/python-two");

          const launches = (yield* Ref.get(requests)).filter(
            (request) => request.kind === "execute",
          );
          Vitest.expect(
            launches.map((request) => request.workingDirectory),
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
    const subscribed = yield* Deferred.make<void>();
    const { layer } = makeTestLayer({
      // Stream.suspend evaluates once per subscription, so the counter still
      // measures how many times the runtime subscribed to `operations`.
      kernelNotifications: Stream.suspend(() => {
        subscriptions += 1;
        return Stream.fromEffect(Deferred.succeed(subscribed, undefined)).pipe(
          Stream.flatMap(() => Stream.never),
        );
      }),
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime.Service;
      yield* notebooks.forNotebook(notebook);
      yield* notebooks.forNotebook(notebookId("notebook-b"));

      yield* Deferred.await(subscribed);
      Vitest.expect(subscriptions).toBe(1);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "owns the selected controller",
  Effect.fn(function* () {
    const { layer } = makeTestLayer();
    const controller: NotebookRuntime.NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: () => Effect.void,
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime.Service;
      const handle = yield* notebooks.forNotebook(notebook);

      Vitest.expect(Option.isNone(yield* handle.getController)).toBe(true);
      yield* notebooks.attachController(notebook, controller);

      Vitest.expect(yield* handle.getController).toEqual(
        Option.some(controller),
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not report a live kernel from controller selection alone",
  Effect.fn(function* () {
    const { layer } = makeTestLayer();
    const editor = VsCodeTest.makeNotebookEditor("/test/notebook_mo.py");
    const controller: NotebookRuntime.NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: () => Effect.void,
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime.Service;
      const vscode = yield* VsCodeTest.Service;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* notebooks.attachController(
        notebookId(editor.notebook.uri.toString()),
        controller,
      );

      const contexts = (yield* vscode.snapshot).executions.filter(
        (execution) =>
          execution.command === "setContext" &&
          execution.args[0] === "marimo.notebook.hasKernel",
      );
      Vitest.expect(contexts.at(-1)?.args[1]).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "restores notebook output without starting a kernel",
  Effect.fn(function* () {
    const editor = VsCodeTest.makeNotebookEditor("/test/notebook.py");
    const requests = yield* Ref.make<ReadonlyArray<MarimoClientTest.Command>>(
      [],
    );
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
    const { layer } = makeTestLayer(
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
    const controller: NotebookRuntime.NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: (_notebook, cells) => Deferred.succeed(presented, cells),
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime.Service;
      yield* NotebookRuntimeHarness.activate(editor);
      const id = notebookId(editor.notebook.uri.toString());
      yield* notebooks.forDocument(editor.notebook);
      yield* notebooks.attachController(id, controller);

      const restored = yield* Deferred.await(presented);
      Vitest.expect(restored).toEqual([replay]);
      Vitest.expect(Option.isNone(yield* notebooks.getRuntimeSession(id))).toBe(
        true,
      );
      const kinds = (yield* Ref.get(requests)).map((request) => request.kind);
      Vitest.expect(kinds).toContain("read-notebook-outputs");
      Vitest.expect(kinds).not.toContain("execute");
      Vitest.expect(kinds).not.toContain("restart-session");
    }).pipe(Effect.provide(layer));
  }),
);

const kernelContexts = (
  executions: ReadonlyArray<VsCodeTest.CommandExecution>,
) =>
  executions
    .filter(
      (execution) =>
        execution.command === "setContext" &&
        execution.args[0] === "marimo.notebook.hasKernel",
    )
    .map((execution) => execution.args[1]);

const hasKernelContexts = (vscode: VsCodeTest.Interface) =>
  Effect.map(vscode.snapshot, ({ executions }) => kernelContexts(executions));

const awaitKernelContext = (vscode: VsCodeTest.Interface, expected: boolean) =>
  vscode
    .awaitExecutions(
      (executions) => kernelContexts(executions).at(-1) === expected,
    )
    .pipe(Effect.andThen(hasKernelContexts(vscode)));

it.effect(
  "reports no kernel for an active notebook with no controller",
  Effect.fn(function* () {
    const { layer } = makeTestLayer();
    const editor = VsCodeTest.makeNotebookEditor("/test/notebook_mo.py");

    yield* Effect.gen(function* () {
      yield* NotebookRuntime.Service;
      const vscode = yield* VsCodeTest.Service;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      const contexts = yield* awaitKernelContext(vscode, false);
      Vitest.expect(contexts.at(-1)).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "reports a live kernel from the server session snapshot",
  Effect.fn(function* () {
    const changes = yield* PubSub.unbounded<ListSessionsResponse>();
    const editor = VsCodeTest.makeNotebookEditor("/test/notebook_mo.py");
    const id = notebookId(editor.notebook.uri.toString());
    const { layer } = makeTestLayer({
      sessionChanges: Stream.fromPubSub(changes),
    });

    yield* Effect.gen(function* () {
      yield* NotebookRuntime.Service;
      const vscode = yield* VsCodeTest.Service;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
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

      const contexts = yield* awaitKernelContext(vscode, true);
      Vitest.expect(contexts.at(-1)).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "releases a notebook's controller when its document closes",
  Effect.fn(function* () {
    const { layer } = makeTestLayer();
    const editor = VsCodeTest.makeNotebookEditor("/test/notebook_mo.py");
    const id = notebookId(editor.notebook.uri.toString());
    const controller: NotebookRuntime.NotebookController = {
      id: "marimo-/usr/bin/python",
      drive: () => () => Effect.void,
      presentOutputs: () => Effect.void,
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime.Service;
      const vscode = yield* VsCodeTest.Service;
      yield* NotebookRuntimeHarness.open(editor);
      yield* notebooks.attachController(id, controller);
      Vitest.expect((yield* hasKernelContexts(vscode)).at(-1)).toBe(false);

      yield* NotebookRuntimeHarness.close(editor.notebook);

      // Closing has completed the document session; resolve a new handle
      // instead of reading the old session's captured controller.
      const released = yield* notebooks
        .forNotebook(id)
        .pipe(Effect.flatMap((notebook) => notebook.getController));
      Vitest.expect(Option.isNone(released)).toBe(true);
      Vitest.expect((yield* hasKernelContexts(vscode)).at(-1)).toBe(false);
      const snapshot = yield* vscode.snapshot;
      Vitest.expect(snapshot.openNotebookUris).toEqual([]);
      Vitest.expect(snapshot.activeNotebookUri).toEqual(Option.none());
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "keeps processing session changes while another notebook is busy",
  Effect.fn(function* () {
    const changes = yield* PubSub.unbounded<ListSessionsResponse>();
    const executionStarted = yield* Deferred.make<void>();
    const releaseExecution = yield* Deferred.make<void>();
    const first = VsCodeTest.makeNotebookEditor(
      NodePath.join(process.cwd(), "busy.py"),
    );
    const second = VsCodeTest.makeNotebookEditor(
      NodePath.join(process.cwd(), "other.py"),
    );
    const firstId = notebookId(first.notebook.uri.toString());
    const secondId = notebookId(second.notebook.uri.toString());
    const { layer, serverSessions, snapshot } = makeTestLayer(
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
      const runtime = yield* NotebookRuntime.Service;
      const vscode = yield* VsCodeTest.Service;
      const firstDocument = yield* runtime.forDocument(first.notebook);
      const secondDocument = yield* runtime.forDocument(second.notebook);
      yield* firstDocument.execute({ cells: [] }, "/python");
      yield* secondDocument.execute({ cells: [] }, "/python");
      yield* vscode.setActiveNotebookEditor(Option.some(second));
      yield* awaitKernelContext(vscode, true);

      const execution = yield* firstDocument
        .execute({ cells: [] }, "/replacement")
        .pipe(Effect.forkChild);
      yield* Deferred.await(executionStarted);
      serverSessions.delete(firstId);
      yield* PubSub.publish(changes, snapshot());
      const sessions = yield* LiveSessions.Service;
      yield* sessions.changes.pipe(
        Stream.filter(
          (items) => !items.some((item) => item.notebookUri === firstId),
        ),
        Stream.runHead,
      );
      Vitest.expect(
        Option.isNone(yield* runtime.getRuntimeSession(firstId)),
      ).toBe(true);
      // This second change must reach the active editor before the busy
      // notebook's command returns, even though its first change is still queued.
      serverSessions.delete(secondId);
      yield* PubSub.publish(changes, snapshot());
      const contexts = yield* awaitKernelContext(vscode, false);
      Vitest.expect(contexts.at(-1)).toBe(false);
      const other = yield* runtime.forNotebook(secondId);
      Vitest.expect((yield* Effect.flip(other.interrupt))._tag).toBe(
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
