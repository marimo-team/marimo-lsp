import * as NodePath from "node:path";

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
  Schema,
  Stream,
  SubscriptionRef,
  TestClock,
} from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { NotebookRange, TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE, SCRATCH_CELL_ID } from "../../constants.ts";
import {
  NotebookRuntime,
  processRuntimeOperations,
} from "../../kernel/NotebookRuntime.ts";
import { PythonController } from "../../kernel/PythonController.ts";
import {
  cellId,
  notebookId,
  variableName,
} from "../../lib/__tests__/branded.ts";
import { DatasourcesService } from "../../panel/datasources/DatasourcesService.ts";
import { VariablesService } from "../../panel/variables/VariablesService.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import * as Api from "../../schemas/Models.gen.ts";
import type {
  CellOperationNotification,
  MarimoApiCall,
  MarimoLspNotificationOf,
} from "../../types.ts";

const withTestCtx = Effect.fn(function* () {
  // Controllable showInputBox via Queue
  const inputQueue = yield* Queue.unbounded<Option.Option<string>>();

  // Capture executeCommand calls
  const executions = yield* SubscriptionRef.make<ReadonlyArray<MarimoApiCall>>(
    [],
  );

  // PubSub to push operations into NotebookRuntime
  const operationsPubSub =
    yield* PubSub.unbounded<MarimoLspNotificationOf<"marimo/operation">>();

  const editor = TestVsCode.makeNotebookEditor(
    NodePath.join(process.cwd(), "notebook_mo.py"),
    {
      data: {
        cells: [
          {
            kind: 1, // Code
            value: "name = input('Enter name: ')",
            languageId: "python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    },
  );

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
    // Merged out (not just provided) so tests can observe the same service
    // instances NotebookRuntime writes to.
    Layer.provideMerge(VariablesService.Default),
    Layer.provideMerge(DatasourcesService.Default),
    Layer.provide(
      makeTestMarimoClient({
        execute(request) {
          return Ref.update(executions, (current) => [
            ...current,
            request,
          ]).pipe(Effect.as(null));
        },
        operations: () => Stream.fromPubSub(operationsPubSub),
      }),
    ),
    Layer.provide(TestTelemetryLive),
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

describe("NotebookRuntime operation processing", () => {
  it.scoped(
    "projects only the latest cell output received during a pending projection",
    Effect.fn(function* () {
      const source =
        yield* PubSub.unbounded<MarimoLspNotificationOf<"marimo/operation">>();
      const firstStarted = yield* Effect.makeLatch();
      const releaseFirst = yield* Effect.makeLatch();
      const latestProcessed = yield* Effect.makeLatch();
      const processed = yield* Ref.make<
        ReadonlyArray<{ runId: string | null | undefined; project: boolean }>
      >([]);
      const notebook = notebookId("notebook");

      const fiber = yield* processRuntimeOperations(
        Stream.fromPubSub(source),
        Effect.fn(function* ({ operation }, options) {
          assert(operation.op === "cell-op");
          yield* Ref.update(processed, (items) => [
            ...items,
            {
              runId: operation.run_id,
              project: options.renderCellOutput,
            },
          ]);
          if (operation.run_id === "one") {
            yield* firstStarted.open;
            yield* releaseFirst.await;
          }
          if (operation.run_id === "three") {
            yield* latestProcessed.open;
          }
        }),
      ).pipe(Effect.fork);
      yield* TestClock.adjust("1 millis");

      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebook, "cell", { run_id: "one" }),
      );
      yield* firstStarted.await;
      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebook, "cell", { run_id: "two" }),
      );
      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebook, "cell", { run_id: "three" }),
      );

      yield* releaseFirst.open;
      yield* latestProcessed.await;
      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(yield* Ref.get(processed), [
        { runId: "one", project: true },
        { runId: "two", project: false },
        { runId: "three", project: true },
      ]);
    }),
  );

  it.scoped(
    "projects the newest renderable output when a state-only cell-op trails it",
    Effect.fn(function* () {
      const source =
        yield* PubSub.unbounded<MarimoLspNotificationOf<"marimo/operation">>();
      const blockerStarted = yield* Effect.makeLatch();
      const releaseBlocker = yield* Effect.makeLatch();
      const trailerProcessed = yield* Effect.makeLatch();
      const processed = yield* Ref.make<
        ReadonlyArray<{ label: string; project: boolean }>
      >([]);
      const notebook = notebookId("notebook");

      const fiber = yield* processRuntimeOperations(
        Stream.fromPubSub(source),
        Effect.fn(function* ({ operation }, options) {
          assert(operation.op === "cell-op");
          const label =
            operation.serialization ?? operation.run_id ?? "unlabelled";
          yield* Ref.update(processed, (items) => [
            ...items,
            { label, project: options.renderCellOutput },
          ]);
          if (label === "blocker") {
            yield* blockerStarted.open;
            yield* releaseBlocker.await;
          }
          if (label === "serialization") yield* trailerProcessed.open;
        }),
      ).pipe(Effect.fork);
      yield* TestClock.adjust("1 millis");

      // Occupy the worker so the next two operations arrive as one batch.
      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebook, "cell", { run_id: "blocker" }),
      );
      yield* blockerStarted.await;

      // The kernel's terminal op for the run, carrying the output it produced.
      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebook, "cell", {
          run_id: "settle",
          output: {
            mimetype: "text/plain",
            channel: "output",
            data: "42",
            timestamp: 0,
          },
        }),
      );
      // Edit mode appends `render_toplevel_defs` after `_set_status_idle`, so a
      // cell defining a top-level function or class emits this payload-less
      // hint right behind the settle op. It must not take the render slot.
      yield* PubSub.publish(source, {
        notebookUri: notebook,
        operation: {
          op: "cell-op" as const,
          cell_id: cellId("cell"),
          serialization: "serialization",
        },
      });

      yield* releaseBlocker.open;
      yield* trailerProcessed.await;
      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(yield* Ref.get(processed), [
        { label: "blocker", project: true },
        { label: "settle", project: true },
        { label: "serialization", project: false },
      ]);
    }),
  );

  it.scoped(
    "processes separate notebooks independently",
    Effect.fn(function* () {
      const source =
        yield* PubSub.unbounded<MarimoLspNotificationOf<"marimo/operation">>();
      const firstStarted = yield* Effect.makeLatch();
      const releaseFirst = yield* Effect.makeLatch();
      const otherProcessed = yield* Effect.makeLatch();
      const secondProcessed = yield* Effect.makeLatch();
      const processed = yield* Ref.make<ReadonlyArray<string>>([]);
      const notebookA = notebookId("notebook-a");
      const notebookB = notebookId("notebook-b");

      const fiber = yield* processRuntimeOperations(
        Stream.fromPubSub(source),
        Effect.fn(function* ({ operation }) {
          assert(operation.op === "cell-op");
          const runId = operation.run_id;
          assert(typeof runId === "string");
          if (runId === "a-1") {
            yield* firstStarted.open;
            yield* releaseFirst.await;
          }
          yield* Ref.update(processed, (items) => [...items, runId]);
          if (runId === "b-1") yield* otherProcessed.open;
          if (runId === "a-2") yield* secondProcessed.open;
        }),
      ).pipe(Effect.fork);
      yield* TestClock.adjust("1 millis");

      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebookA, "cell", { run_id: "a-1" }),
      );
      yield* firstStarted.await;
      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebookA, "cell", { run_id: "a-2" }),
      );
      yield* PubSub.publish(
        source,
        makeIdleCellOperation(notebookB, "cell", { run_id: "b-1" }),
      );

      yield* otherProcessed.await;
      assert.deepStrictEqual(yield* Ref.get(processed), ["b-1"]);

      yield* releaseFirst.open;
      yield* secondProcessed.await;
      yield* Fiber.interrupt(fiber);

      assert.deepStrictEqual(yield* Ref.get(processed), ["b-1", "a-1", "a-2"]);
    }),
  );
});

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
          method: "delete-cell",
          params: {
            notebookUri: ctx.notebookUri,
            inner: { cellId: "cell-1" },
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
          commands.some((command) => command.method === "delete-cell"),
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
        const stdinCmd = cmds.find((c) => c.method === "send-stdin");
        expect(stdinCmd).toMatchObject({
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
        const stdinCmd = cmds.find((c) => c.method === "send-stdin");
        expect(stdinCmd).toBeUndefined();

        // An interrupt should have been sent instead
        const interruptCmd = cmds.find((c) => c.method === "interrupt");
        expect(interruptCmd).toMatchObject({
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

        const scratchpadCalls = (calls: ReadonlyArray<MarimoApiCall>) =>
          calls
            .filter((call) => call.method === "execute-scratchpad")
            .map((call) =>
              Schema.decodeUnknownSync(Api.ExecuteScratchpadPayload)(
                call.params,
              ),
            );

        const first_ = scratchpadCalls(yield* Ref.get(ctx.executions));
        expect(first_).toHaveLength(1);
        const firstCommand = first_[0];
        assert(
          firstCommand !== undefined &&
            typeof firstCommand.inner.runId === "string",
        );

        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: {
            op: "completed-run",
            run_id: firstCommand.inner.runId,
          },
        });
        yield* TestClock.adjust("1 millis");

        const commands = scratchpadCalls(yield* Ref.get(ctx.executions));
        expect(commands).toHaveLength(2);
        const secondCommand = commands[1];
        assert(
          secondCommand !== undefined &&
            typeof secondCommand.inner.runId === "string",
        );

        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: {
            op: "completed-run",
            run_id: secondCommand.inner.runId,
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
        NodePath.join(process.cwd(), "other_notebook_mo.py"),
      );
      const otherNotebook = MarimoNotebookDocument.from(otherEditor.notebook);

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime;
        yield* ctx.vscode.addNotebookDocument(otherEditor.notebook);
        yield* ctx.vscode.openNotebook(otherEditor.notebook);
        yield* TestClock.adjust("1 millis");
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

        const executions = yield* ctx.executions.changes.pipe(
          Stream.filter(
            (calls) =>
              calls.filter((call) => call.method === "execute-scratchpad")
                .length === 2,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        const commands: Array<{
          notebookUri: NotebookId;
          runId: string;
        }> = [];
        for (const command of executions) {
          if (command.method === "execute-scratchpad") {
            const params = Schema.decodeUnknownSync(
              Api.ExecuteScratchpadPayload,
            )(command.params);
            assert(typeof params.inner.runId === "string");
            commands.push({
              notebookUri: notebookId(params.notebookUri),
              runId: params.inner.runId,
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
          (c) => c.method === "execute-scratchpad",
        );

        assert(executeCmd !== undefined);
        const { runId } = Schema.decodeUnknownSync(
          Api.ExecuteScratchpadPayload,
        )(executeCmd.params).inner;
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
        const interruptCmd = executions.find((c) => c.method === "interrupt");

        expect(interruptCmd).toMatchObject({
          method: "interrupt",
          params: { inner: {}, notebookUri: ctx.notebookUri },
        });
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
          (c) => c.method === "execute-scratchpad",
        );
        assert(executeCmd !== undefined);
        const { runId } = Schema.decodeUnknownSync(
          Api.ExecuteScratchpadPayload,
        )(executeCmd.params).inner;

        // Our completed-run ends the stream normally.
        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: { op: "completed-run", run_id: runId },
        });

        yield* Fiber.join(streamFiber);

        const interruptCmd = (yield* Ref.get(ctx.executions)).find(
          (c) => c.method === "interrupt",
        );
        expect(interruptCmd).toBeUndefined();
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});

describe("NotebookRuntime state eviction", () => {
  it.scoped(
    "evicts variables and datasource state when a notebook closes",
    Effect.fn(function* () {
      const ctx = yield* withTestCtx();

      yield* Effect.gen(function* () {
        yield* NotebookRuntime;
        const variables = yield* VariablesService;
        const datasources = yield* DatasourcesService;

        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: {
            op: "variables",
            variables: [
              {
                name: variableName("x"),
                declared_by: [cellId("cell-1")],
                used_by: [],
              },
            ],
          },
        });
        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: { op: "datasets", tables: [] },
        });
        yield* TestClock.adjust("10 millis");

        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);
        expect(
          Option.isSome(yield* datasources.getDatasets(ctx.notebookUri)),
        ).toBe(true);

        yield* ctx.vscode.closeNotebook(ctx.editor.notebook);
        yield* TestClock.adjust("10 millis");

        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(false);
        expect(
          Option.isSome(yield* datasources.getDatasets(ctx.notebookUri)),
        ).toBe(false);

        // Notifications already queued, or delivered late by the old kernel
        // session, must not recreate state after eviction.
        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: {
            op: "variables",
            variables: [
              {
                name: variableName("late"),
                declared_by: [cellId("cell-1")],
                used_by: [],
              },
            ],
          },
        });
        yield* TestClock.adjust("10 millis");
        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(false);

        // Reopening establishes a fresh session token and accepts new events.
        yield* ctx.vscode.openNotebook(ctx.editor.notebook);
        yield* TestClock.adjust("10 millis");
        yield* PubSub.publish(ctx.operationsPubSub, {
          notebookUri: ctx.notebookUri,
          operation: { op: "variables", variables: [] },
        });
        yield* TestClock.adjust("10 millis");
        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
