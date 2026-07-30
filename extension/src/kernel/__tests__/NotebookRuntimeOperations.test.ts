import { assert, describe, expect, it } from "@effect/vitest";
import {
  Chunk,
  Effect,
  Fiber,
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
import { NotebookRange, TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE, SCRATCH_CELL_ID } from "../../constants.ts";
import { PythonController } from "../../kernel/NotebookControllerFactory.ts";
import { NotebookRuntime } from "../../kernel/NotebookRuntime.ts";
import { cellId } from "../../lib/__tests__/branded.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  MarimoCommand,
  MarimoLspNotificationOf,
} from "../../types.ts";

const withTestCtx = Effect.fn(function* () {
  // Controllable showInputBox via Queue
  const inputQueue = yield* Queue.unbounded<Option.Option<string>>();

  // Capture executeCommand calls
  const executions = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);

  // PubSub to push operations into NotebookRuntime
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
    Layer.provideMerge(NotebookRuntime.Default),
    Layer.provide(
      makeTestMarimoClient({
        execute(request) {
          const command: MarimoCommand = {
            command: "marimo.api",
            params: request,
          };
          return Ref.update(executions, (current) => [...current, command]);
        },
        operations: () => Stream.fromPubSub(operationsPubSub),
      }),
    ),
    Layer.provide(TestTelemetryLive),
    Layer.provide(TestSentryLive),
    Layer.provide(TestPythonExtension.Default),
    Layer.provideMerge(vscode.layer),
  );

  const selectedLayer = Layer.effectDiscard(
    NotebookRuntime.pipe(
      Effect.flatMap((runtime) =>
        runtime.attachController(notebookUri, mockController),
      ),
    ),
  ).pipe(Layer.provide(layer));

  return {
    layer: Layer.merge(layer, selectedLayer),
    vscode,
    editor,
    notebook,
    notebookUri,
    mockController,
    executions,
    inputQueue,
    operationsPubSub,
  };
});

function makeIdleCellOperation(
  notebookUri: NotebookId,
  cid: string,
  overrides: Partial<CellOperationNotification> = {},
): MarimoLspNotificationOf<"marimo/operation"> {
  return {
    notebookUri,
    operation: {
      op: "cell-op" as const,
      cell_id: cellId(cid),
      status: "idle",
      ...overrides,
    },
  };
}

describe("NotebookRuntime cell identity", () => {
  it.scoped(
    "notifies marimo when a cell is deleted",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        yield* NotebookRuntime;

        const cell = ctx.editor.notebook.cellAt(0);
        yield* ctx.vscode.notebookChange({
          notebook: ctx.editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new NotebookRange(0, 1),
              removedCells: [cell],
              addedCells: [],
            },
          ],
        });
        yield* TestClock.adjust("10 millis");

        expect(yield* Ref.get(ctx.executions)).toContainEqual({
          command: "marimo.api",
          params: {
            method: "delete-cell",
            params: {
              notebookUri: ctx.notebookUri,
              inner: { cellId: "cell-1" },
            },
          },
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "does not delete a cell that moved within the notebook",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        yield* NotebookRuntime;

        const cell = ctx.editor.notebook.cellAt(0);
        yield* ctx.vscode.notebookChange({
          notebook: ctx.editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new NotebookRange(0, 1),
              removedCells: [cell],
              addedCells: [],
            },
            {
              range: new NotebookRange(1, 1),
              removedCells: [],
              addedCells: [cell],
            },
          ],
        });
        yield* TestClock.adjust("10 millis");

        const commands = yield* Ref.get(ctx.executions);
        expect(
          commands.some(
            (command) =>
              command.command === "marimo.api" &&
              command.params.method === "delete-cell",
          ),
        ).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});

describe("NotebookRuntime stdin", () => {
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
        expect(stdinCmd).toMatchObject({
          params: {
            method: "send-stdin",
            params: {
              notebookUri: ctx.notebookUri,
              inner: { text: "foo" },
            },
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
        expect(interruptCmd).toMatchObject({
          params: {
            method: "interrupt",
            params: {
              notebookUri: ctx.notebookUri,
              inner: {},
            },
          },
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});

describe("NotebookRuntime scratch stream", () => {
  it.scoped(
    "runs one scratchpad at a time within a notebook",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const notebook = (yield* NotebookRuntime).forNotebook(ctx.notebookUri);
        const first = yield* Effect.fork(
          notebook.executeScratchpad("print('first')").pipe(Stream.runDrain),
        );
        const second = yield* Effect.fork(
          notebook.executeScratchpad("print('second')").pipe(Stream.runDrain),
        );

        yield* TestClock.adjust("1 millis");

        const firstCommand = (yield* Ref.get(ctx.executions)).find(
          (command) =>
            command.command === "marimo.api" &&
            command.params.method === "execute-scratchpad",
        );
        assert(
          firstCommand !== undefined &&
            firstCommand.command === "marimo.api" &&
            firstCommand.params.method === "execute-scratchpad" &&
            typeof firstCommand.params.params.inner.runId === "string",
        );
        expect(
          (yield* Ref.get(ctx.executions)).filter(
            (command) =>
              command.command === "marimo.api" &&
              command.params.method === "execute-scratchpad",
          ),
        ).toHaveLength(1);

        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: {
            op: "completed-run",
            run_id: firstCommand.params.params.inner.runId,
          },
        });
        yield* TestClock.adjust("1 millis");

        const commands = (yield* Ref.get(ctx.executions)).filter(
          (command) =>
            command.command === "marimo.api" &&
            command.params.method === "execute-scratchpad",
        );
        expect(commands).toHaveLength(2);
        const secondCommand = commands[1];
        assert(
          secondCommand !== undefined &&
            secondCommand.command === "marimo.api" &&
            secondCommand.params.method === "execute-scratchpad" &&
            typeof secondCommand.params.params.inner.runId === "string",
        );

        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: {
            op: "completed-run",
            run_id: secondCommand.params.params.inner.runId,
          },
        });

        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "allows scratchpad execution in separate notebooks",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();
      const otherEditor = TestVsCode.makeNotebookEditor(
        "/test/other_notebook_mo.py",
      );
      const otherNotebook = MarimoNotebookDocument.from(otherEditor.notebook);

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime;
        yield* ctx.vscode.addNotebookDocument(otherEditor.notebook);
        yield* runtime.attachController(otherNotebook.id, ctx.mockController);

        const first = yield* Effect.fork(
          runtime
            .forNotebook(ctx.notebookUri)
            .executeScratchpad("print('first')")
            .pipe(Stream.runDrain),
        );
        const second = yield* Effect.fork(
          runtime
            .forNotebook(otherNotebook.id)
            .executeScratchpad("print('second')")
            .pipe(Stream.runDrain),
        );

        yield* TestClock.adjust("1 millis");

        const commands: Array<{
          notebookUri: NotebookId;
          runId: string;
        }> = [];
        for (const command of yield* Ref.get(ctx.executions)) {
          if (
            command.command === "marimo.api" &&
            command.params.method === "execute-scratchpad"
          ) {
            assert(typeof command.params.params.inner.runId === "string");
            commands.push({
              notebookUri: command.params.params.notebookUri,
              runId: command.params.params.inner.runId,
            });
          }
        }
        expect(
          commands
            .map((command) => command.notebookUri)
            .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(
          [ctx.notebookUri, otherNotebook.id].toSorted((a, b) =>
            a.localeCompare(b),
          ),
        );

        for (const command of commands) {
          yield* PubSub.publish(ctx.operationsPubSub, {
            notebookUri: command.notebookUri,
            operation: {
              op: "completed-run",
              run_id: command.runId,
            },
          });
        }

        yield* Fiber.join(first);
        yield* Fiber.join(second);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "streams scratch + cascade console ops until the matching completed-run",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime;

        // Route cell-op notifications through processSessionOperation.
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        const streamFiber = yield* Effect.fork(
          runtime
            .forNotebook(ctx.notebookUri)
            .executeScratchpad("print('hi')")
            .pipe(Stream.runCollect),
        );

        // Let executeScratchpad enqueue marimo.api with its generated runId.
        yield* TestClock.adjust("1 millis");

        const executions = yield* Ref.get(ctx.executions);
        const executeCmd = executions.find(
          (c) =>
            c.command === "marimo.api" &&
            c.params.method === "execute-scratchpad",
        );

        assert(
          executeCmd !== undefined &&
            executeCmd.command === "marimo.api" &&
            executeCmd.params.method === "execute-scratchpad",
        );
        const runId = executeCmd.params.params.inner.runId;
        expect(runId).toBeDefined();

        const cell = ctx.notebook.cellAt(0);
        const realCellId = Option.getOrThrow(cell.id);

        // The scratch cell's op carries the run's output. marimo leaves its
        // run_id null (only the completed-run echoes ours), so we key on the
        // SCRATCH_CELL_ID, not the run_id.
        yield* PubSub.publish(
          ctx.operationsPubSub,
          makeIdleCellOperation(ctx.notebookUri, SCRATCH_CELL_ID, {
            status: "running",
            console: [
              {
                channel: "stdout",
                data: "hi",
                mimetype: "text/plain",
                timestamp: 0,
              },
            ],
          }),
        );

        // Console from a cascade cell (one code mode ran) also streams.
        yield* PubSub.publish(
          ctx.operationsPubSub,
          makeIdleCellOperation(ctx.notebookUri, realCellId, {
            status: "running",
            console: [
              {
                channel: "stdout",
                data: "from cascade",
                mimetype: "text/plain",
                timestamp: 0,
              },
            ],
          }),
        );

        // A status-only cascade op (no console) is not streamed.
        yield* PubSub.publish(
          ctx.operationsPubSub,
          makeIdleCellOperation(ctx.notebookUri, realCellId, {
            status: "idle",
          }),
        );

        // Our completed-run ends the stream (inclusive; filtered back out).
        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: {
            op: "completed-run",
            run_id: runId,
          },
        });

        const ops = Chunk.toReadonlyArray(yield* Fiber.join(streamFiber));
        const cellIds = ops.map((op) => op.cell_id);
        expect(ops).toHaveLength(2);
        expect(cellIds).toContain(SCRATCH_CELL_ID);
        expect(cellIds).toContain(realCellId);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "interrupts the kernel when the stream is abandoned before completed-run",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime;

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        const streamFiber = yield* Effect.fork(
          runtime
            .forNotebook(ctx.notebookUri)
            .executeScratchpad("print('hi')")
            .pipe(Stream.runCollect),
        );

        // Let executeScratchpad send the command and arm the
        // interrupt-on-abandon finalizer.
        yield* TestClock.adjust("1 millis");

        // Abandon the stream before any completed-run arrives (mirrors a
        // cancelled tool invocation interrupting the fiber).
        yield* Fiber.interrupt(streamFiber);

        const executions = yield* Ref.get(ctx.executions);

        // The finalizer should have sent an interrupt to the kernel.
        const interruptCmd = executions.find(
          (c) => c.command === "marimo.api" && c.params.method === "interrupt",
        );

        expect(interruptCmd).toMatchInlineSnapshot(`
        	{
        	  "command": "marimo.api",
        	  "params": {
        	    "method": "interrupt",
        	    "params": {
        	      "inner": {},
        	      "notebookUri": "file:///test/notebook_mo.py",
        	    },
        	  },
        	}
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "does not interrupt the kernel after a normal completed-run",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime;

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* TestClock.adjust("1 millis");

        const streamFiber = yield* Effect.fork(
          runtime
            .forNotebook(ctx.notebookUri)
            .executeScratchpad("print('hi')")
            .pipe(Stream.runCollect),
        );

        yield* TestClock.adjust("1 millis");

        const executeCmd = (yield* Ref.get(ctx.executions)).find(
          (c) =>
            c.command === "marimo.api" &&
            c.params.method === "execute-scratchpad",
        );
        assert(
          executeCmd !== undefined &&
            executeCmd.command === "marimo.api" &&
            executeCmd.params.method === "execute-scratchpad",
        );
        const runId = executeCmd.params.params.inner.runId;

        // Our completed-run ends the stream normally.
        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: { op: "completed-run", run_id: runId },
        });

        yield* Fiber.join(streamFiber);

        const interruptCmd = (yield* Ref.get(ctx.executions)).find(
          (c) => c.command === "marimo.api" && c.params.method === "interrupt",
        );
        expect(interruptCmd).toBeUndefined();
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
