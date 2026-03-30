import { describe, expect, it } from "@effect/vitest";
import {
  Effect,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Stream,
  TestClock,
} from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { MarimoNotebookDocument, type NotebookId } from "../../schemas.ts";
import type {
  CellOperationNotification,
  MarimoCommand,
  MarimoLspNotificationOf,
} from "../../types.ts";
import { ControllerRegistry } from "../ControllerRegistry.ts";
import { KernelManager } from "../KernelManager.ts";
import { LanguageClient } from "../LanguageClient.ts";
import { PythonController } from "../NotebookControllerFactory.ts";
import { VsCode } from "../VsCode.ts";

const withTestCtx = Effect.fn(function* () {
  // Controllable showInputBox via Queue
  const inputQueue = yield* Queue.unbounded<Option.Option<string>>();

  // Capture executeCommand calls
  const executions = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);

  // PubSub to push operations into the KernelManager stream
  const operationsPubSub =
    yield* PubSub.unbounded<MarimoLspNotificationOf<"marimo/operation">>();

  const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
    data: {
      cells: [
        {
          kind: 1, // Code
          value: "name = input('Enter name: ')",
          languageId: "python",
          metadata: { stableId: "cell-1" },
        },
      ],
    },
  });

  const notebook = MarimoNotebookDocument.from(editor.notebook);
  const notebookUri = notebook.id;

  const vscode = yield* TestVsCode.make({
    initialDocuments: [editor.notebook],
    window: {
      showInputBox: () => Queue.take(inputQueue),
    },
  });

  const mockController = yield* Effect.gen(function* () {
    const code = yield* VsCode;
    const controller = yield* code.notebooks.createNotebookController(
      "test-controller",
      NOTEBOOK_TYPE,
      "Test Controller",
    );
    return new PythonController(controller, "/usr/bin/python3");
  }).pipe(Effect.provide(vscode.layer));

  const layer = Layer.empty.pipe(
    Layer.provideMerge(KernelManager.Default),
    Layer.provide(
      Layer.succeed(
        ControllerRegistry,
        ControllerRegistry.make({
          getActiveController: () =>
            Effect.succeed(Option.some(mockController)),
          snapshot: () => Effect.succeed({ controllers: [], selections: [] }),
        }),
      ),
    ),
    Layer.provide(
      Layer.succeed(
        LanguageClient,
        LanguageClient.make({
          channel: { name: "marimo-lsp", show() {} },
          restart: () => Effect.void,
          executeCommand(cmd) {
            return Ref.update(executions, (arr) => [...arr, cmd]);
          },
          streamOf() {
            return Stream.fromPubSub(operationsPubSub) as never;
          },
        }),
      ),
    ),
    Layer.provide(TestTelemetryLive),
    Layer.provide(TestSentryLive),
    Layer.provide(TestPythonExtension.Default),
    Layer.provideMerge(vscode.layer),
  );

  return {
    layer,
    vscode,
    editor,
    notebook,
    notebookUri,
    executions,
    inputQueue,
    operationsPubSub,
  };
});

function makeIdleCellOperation(
  notebookUri: NotebookId,
  cellId: string,
  overrides: Partial<CellOperationNotification> = {},
): MarimoLspNotificationOf<"marimo/operation"> {
  return {
    notebookUri,
    operation: {
      op: "cell-op" as const,
      cell_id: cellId,
      status: "idle",
      ...overrides,
    },
  };
}

describe("KernelManager stdin", () => {
  it.scoped(
    "prompts for input on stdin cell-op and sends response",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const cell = ctx.notebook.cellAt(0);
        const cellId = Option.getOrThrow(cell.id);

        // Set active editor so NotebookEditorRegistry can find it
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        // Push a cell-op with stdin console output
        yield* PubSub.publish(
          ctx.operationsPubSub,
          makeIdleCellOperation(ctx.notebookUri, cellId, {
            status: "running",
            console: [
              {
                channel: "stdin",
                data: "Enter name: ",
                mimetype: "text/plain",
                timestamp: 0,
              },
            ],
          }),
        );
        yield* TestClock.adjust("1 millis");

        // Provide the input (unblocks showInputBox)
        yield* Queue.offer(ctx.inputQueue, Option.some("foo"));
        yield* TestClock.adjust("1 millis");

        // Assert executeCommand was called with send-stdin
        const cmds = yield* Ref.get(ctx.executions);
        const stdinCmd = cmds.find(
          (c) => c.command === "marimo.api" && c.params.method === "send-stdin",
        );
        expect(stdinCmd).toBeDefined();
        expect(stdinCmd!.params).toMatchObject({
          method: "send-stdin",
          params: {
            notebookUri: ctx.notebookUri,
            inner: { text: "foo" },
          },
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "does not send command when user cancels input",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const cell = ctx.notebook.cellAt(0);
        const cellId = Option.getOrThrow(cell.id);

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("10 millis");

        yield* PubSub.publish(
          ctx.operationsPubSub,
          makeIdleCellOperation(ctx.notebookUri, cellId, {
            status: "running",
            console: [
              {
                channel: "stdin",
                data: "Enter name: ",
                mimetype: "text/plain",
                timestamp: 0,
              },
            ],
          }),
        );
        yield* TestClock.adjust("1 millis");

        // User cancels the input box
        yield* Queue.offer(ctx.inputQueue, Option.none());
        yield* TestClock.adjust("1 millis");

        // No send-stdin command should have been sent
        const cmds = yield* Ref.get(ctx.executions);
        const stdinCmd = cmds.find(
          (c) => c.command === "marimo.api" && c.params.method === "send-stdin",
        );
        expect(stdinCmd).toBeUndefined();

        // An interrupt should have been sent instead
        const interruptCmd = cmds.find(
          (c) => c.command === "marimo.api" && c.params.method === "interrupt",
        );
        expect(interruptCmd).toBeDefined();
        expect(interruptCmd!.params).toMatchObject({
          method: "interrupt",
          params: {
            notebookUri: ctx.notebookUri,
            inner: {},
          },
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
