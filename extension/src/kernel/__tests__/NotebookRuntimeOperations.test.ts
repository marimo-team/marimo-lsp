import * as NodePath from "node:path";

import { assert, describe, expect, it as test } from "@effect/vitest";
import { Effect, Fiber, Latch, Option, Ref, Stream } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import type { TestCommand } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { SCRATCH_CELL_ID } from "../../constants.ts";
import { makeNotebookExecutor } from "../../kernel/NotebookExecutor.ts";
import * as NotebookRuntime from "../../kernel/NotebookRuntime.ts";
import {
  cellId,
  kernelSessionId,
  notebookId,
  variableName,
} from "../../lib/__tests__/branded.ts";
import * as NotebookDatasources from "../../panel/datasources/NotebookDatasources.ts";
import * as NotebookVariables from "../../panel/variables/NotebookVariables.ts";
import {
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  KernelNotification,
} from "../../types.ts";
import * as TestNotebookRuntime from "./TestNotebookRuntime.ts";

const ACTIVE_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000001",
);
const it = EffectTest.make(TestNotebookRuntime.layer);
const cancellationIt = EffectTest.make(
  TestNotebookRuntime.layerWith({ suspendWorkspaceEdits: true }),
);

const settle = <A, E, R>(
  get: Effect.Effect<A, E, R>,
  predicate: (value: A) => boolean,
  failure: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt <= 100; attempt++) {
      const value = yield* get;
      if (predicate(value)) return value;
      if (attempt < 100) yield* Effect.yieldNow;
    }
    return yield* Effect.fail(failure);
  });

function makeIdleCellOperation(
  notebookUri: NotebookId,
  cid: string,
  overrides: Partial<CellOperationNotification> = {},
): KernelNotification {
  return {
    notebookUri,
    sessionId: ACTIVE_SESSION_ID,
    notification: {
      op: "cell-op" as const,
      cell_id: cellId(cid),
      status: "idle",
      ...overrides,
    },
  };
}

describe("NotebookRuntime operation processing", () => {
  test.effect(
    "processes every queued notebook operation in order",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const firstStarted = yield* Latch.make();
      const releaseFirst = yield* Latch.make();
      const latestProcessed = yield* Latch.make();
      const processed = yield* Ref.make<ReadonlyArray<string | undefined>>([]);
      const notebook = notebookId("notebook");

      const process = (runId: string) =>
        Effect.gen(function* () {
          yield* Ref.update(processed, (items) => [...items, runId]);
          if (runId === "one") {
            yield* firstStarted.open;
            yield* releaseFirst.await;
          }
          if (runId === "three") {
            yield* latestProcessed.open;
          }
        });

      yield* executor.post(notebook, process("one"));
      yield* firstStarted.await;
      yield* executor.post(notebook, process("two"));
      yield* executor.post(notebook, process("three"));

      yield* releaseFirst.open;
      yield* latestProcessed.await;

      assert.deepStrictEqual(yield* Ref.get(processed), [
        "one",
        "two",
        "three",
      ]);
    }),
  );

  test.effect(
    "processes a state-only cell operation after its terminal output",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const blockerStarted = yield* Latch.make();
      const releaseBlocker = yield* Latch.make();
      const trailerProcessed = yield* Latch.make();
      const processed = yield* Ref.make<ReadonlyArray<string>>([]);
      const notebook = notebookId("notebook");

      const process = (label: string) =>
        Effect.gen(function* () {
          yield* Ref.update(processed, (items) => [...items, label]);
          if (label === "blocker") {
            yield* blockerStarted.open;
            yield* releaseBlocker.await;
          }
          if (label === "serialization") yield* trailerProcessed.open;
        });

      // Occupy the worker so the next two operations arrive as one batch.
      yield* executor.post(notebook, process("blocker"));
      yield* blockerStarted.await;

      // The kernel's terminal op for the run, carrying the output it produced.
      yield* executor.post(notebook, process("settle"));
      // Edit mode appends `render_toplevel_defs` after `_set_status_idle`, so a
      // cell defining a top-level function or class emits this payload-less
      // hint right behind the settle op. It must not take the render slot.
      yield* executor.post(notebook, process("serialization"));

      yield* releaseBlocker.open;
      yield* trailerProcessed.await;

      assert.deepStrictEqual(yield* Ref.get(processed), [
        "blocker",
        "settle",
        "serialization",
      ]);
    }),
  );

  test.effect(
    "processes separate notebooks independently",
    Effect.fn(function* () {
      const executor = yield* makeNotebookExecutor<never>();
      const firstStarted = yield* Latch.make();
      const releaseFirst = yield* Latch.make();
      const otherProcessed = yield* Latch.make();
      const secondProcessed = yield* Latch.make();
      const processed = yield* Ref.make<ReadonlyArray<string>>([]);
      const notebookA = notebookId("notebook-a");
      const notebookB = notebookId("notebook-b");

      const process = (runId: string) =>
        Effect.gen(function* () {
          if (runId === "a-1") {
            yield* firstStarted.open;
            yield* releaseFirst.await;
          }
          yield* Ref.update(processed, (items) => [...items, runId]);
          if (runId === "b-1") yield* otherProcessed.open;
          if (runId === "a-2") yield* secondProcessed.open;
        });

      yield* executor.post(notebookA, process("a-1"));
      yield* firstStarted.await;
      yield* executor.post(notebookA, process("a-2"));
      yield* executor.post(notebookB, process("b-1"));

      yield* otherProcessed.await;
      assert.deepStrictEqual(yield* Ref.get(processed), ["b-1"]);

      yield* releaseFirst.open;
      yield* secondProcessed.await;

      assert.deepStrictEqual(yield* Ref.get(processed), ["b-1", "a-1", "a-2"]);
    }),
  );

  cancellationIt.effect(
    "does not report session cancellation as an operation failure",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;

        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: {
            op: "notebook-document-transaction",
            transaction: {
              changes: [
                {
                  type: "set-code",
                  cellId: cellId("cell-1"),
                  code: "name = 'closed'",
                },
              ],
              source: "code-mode",
              version: 1,
            },
          },
        });
        yield* ctx.workspaceEditStarted;

        yield* ctx.vscode.closeNotebook(ctx.editor.notebook);
        yield* Effect.yieldNow;

        expect(yield* ctx.errors).toEqual([]);
      });
    }),
  );
});

describe("NotebookRuntime cell identity", () => {
  it.effect(
    "notifies marimo when a cell is deleted",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;
        // One scheduler drain so NotebookRuntime's forked
        // notebookDocumentChanges consumer subscribes to the mock PubSub
        // before we publish the change event. In production this stream is a
        // vscode event listener registered during activation, so the event
        // cannot fire before the listener exists; the mock's PubSub has no
        // replay, so a publish before the fork first runs is silently lost.
        yield* Effect.yieldNow;

        const cell = ctx.editor.notebook.cellAt(0);
        yield* ctx.vscode.notebookChange({
          notebook: ctx.editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new TestVsCode.NotebookRange(0, 1),
              removedCells: [cell],
              addedCells: [],
            },
          ],
        });
        const executions = yield* ctx.executionChanges.pipe(
          Stream.filter((commands) =>
            commands.some((command) => command.kind === "delete-cell"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        expect(executions).toContainEqual({
          kind: "delete-cell",
          notebookUri: ctx.notebookUri,
          kernelSessionId: ACTIVE_SESSION_ID,
          cellId: "cell-1",
        });
      });
    }),
  );

  it.effect(
    "does not delete a cell that moved within the notebook",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;
        // Drain so the change event below is actually delivered (see the
        // deleted-cell test above); without it this test would pass vacuously
        // because the mock PubSub drops events published before the forked
        // consumer subscribes.
        yield* Effect.yieldNow;

        const cell = ctx.editor.notebook.cellAt(0);
        yield* ctx.vscode.notebookChange({
          notebook: ctx.editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new TestVsCode.NotebookRange(0, 1),
              removedCells: [cell],
              addedCells: [],
            },
            {
              range: new TestVsCode.NotebookRange(1, 1),
              removedCells: [],
              addedCells: [cell],
            },
          ],
        });

        // The assertion below is negative, so the unchanged command list
        // cannot tell us when the move has been processed. Follow it with an
        // observable deletion on the same sequential change stream. Once the
        // marker deletion is recorded, the preceding move event has completed.
        const markerCell = TestVsCode.createTestNotebookDocument(
          NodePath.join(process.cwd(), "cell-move-marker_mo.py"),
          {
            data: {
              cells: [
                {
                  kind: 1,
                  value: "",
                  languageId: "python",
                  metadata: MarimoNotebookCell.createMetadata({
                    marimoRuntime: { stableId: "cell-move-marker" },
                  }),
                },
              ],
            },
          },
        ).cellAt(0);
        yield* ctx.vscode.notebookChange({
          notebook: ctx.editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new TestVsCode.NotebookRange(1, 1),
              removedCells: [markerCell],
              addedCells: [],
            },
          ],
        });
        const commands = yield* settle(
          ctx.executions,
          (calls) =>
            calls.some(
              (command) =>
                command.kind === "delete-cell" &&
                command.cellId === "cell-move-marker",
            ),
          "cell change pipeline did not settle",
        );

        expect(
          commands.some(
            (command) =>
              command.kind === "delete-cell" && command.cellId === "cell-1",
          ),
        ).toBe(false);
      });
    }),
  );
});

describe("NotebookRuntime stdin", () => {
  it.effect(
    "prompts for input on stdin cell-op and sends response",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const cell = ctx.notebook.cellAt(0);
        const cellId = Option.getOrThrow(cell.id);

        // Set active editor so NotebookEditorRegistry can find it
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;

        // Push a cell-op with stdin console output
        yield* ctx.publishOperation(
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
        yield* Effect.yieldNow;

        // Provide the input (unblocks showInputBox)
        yield* ctx.provideInput(Option.some("foo"));

        // Assert executeCommand was called with send-stdin
        const cmds = yield* ctx.executions.pipe(
          Effect.filterOrFail(
            (calls) => calls.some((call) => call.kind === "send-stdin"),
            () => "stdin response not sent" as const,
          ),
          Effect.eventually,
        );
        const stdinCmd = cmds.find((c) => c.kind === "send-stdin");
        expect(stdinCmd).toMatchObject({
          kind: "send-stdin",
          notebookUri: ctx.notebookUri,
          kernelSessionId: ACTIVE_SESSION_ID,
          text: "foo",
        });
      });
    }),
  );

  it.effect(
    "does not send command when user cancels input",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const cell = ctx.notebook.cellAt(0);
        const cellId = Option.getOrThrow(cell.id);

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;

        yield* ctx.publishOperation(
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
        yield* Effect.yieldNow;

        // User cancels the input box
        yield* ctx.provideInput(Option.none());
        const cmds = yield* ctx.executionChanges.pipe(
          Stream.filter((calls) =>
            calls.some((call) => call.kind === "interrupt"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        // No send-stdin command should have been sent
        const stdinCmd = cmds.find((c) => c.kind === "send-stdin");
        expect(stdinCmd).toBeUndefined();

        // An interrupt should have been sent instead
        const interruptCmd = cmds.find((c) => c.kind === "interrupt");
        expect(interruptCmd).toMatchObject({
          kind: "interrupt",
          notebookUri: ctx.notebookUri,
          kernelSessionId: ACTIVE_SESSION_ID,
        });
      });
    }),
  );

  it.effect(
    "cancels an in-flight prompt when its notebook session closes",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const cellId = Option.getOrThrow(ctx.notebook.cellAt(0).id);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;

        yield* ctx.publishOperation(
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
        yield* ctx.inputRequested;

        yield* ctx.vscode.closeNotebook(ctx.editor.notebook);
        yield* Effect.yieldNow;
        yield* ctx.provideInput(Option.some("stale response"));
        yield* Effect.yieldNow;

        expect(
          (yield* ctx.executions).some(
            (command) => command.kind === "send-stdin",
          ),
        ).toBe(false);
      });
    }),
  );

  it.effect(
    "does not send an old prompt response to a replacement kernel",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;
        const cellId = Option.getOrThrow(ctx.notebook.cellAt(0).id);
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;

        yield* ctx.publishOperation(
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
        yield* ctx.inputRequested;

        const notebook = yield* runtime.forNotebook(ctx.notebookUri);
        yield* notebook.restart;
        yield* ctx.provideInput(Option.some("stale response"));
        yield* Effect.yieldNow;

        expect(
          (yield* ctx.executions).some(
            (command) => command.kind === "send-stdin",
          ),
        ).toBe(false);
      });
    }),
  );
});

describe("NotebookRuntime scratch stream", () => {
  it.effect(
    "runs one scratchpad at a time within a notebook",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);
        const first = yield* Effect.forkChild(
          notebook.executeScratchpad("print('first')").pipe(Stream.runDrain),
        );
        const second = yield* Effect.forkChild(
          notebook.executeScratchpad("print('second')").pipe(Stream.runDrain),
        );

        const scratchpadCalls = (calls: ReadonlyArray<TestCommand>) =>
          calls.filter((call) => call.kind === "execute-scratchpad");

        // Wait until the first command is recorded. Do not count scheduler
        // drains. The scratchpad setup can need more than one drain.
        yield* ctx.executionChanges.pipe(
          Stream.filter((calls) => scratchpadCalls(calls).length >= 1),
          Stream.runHead,
        );
        // Extra drain: give the second scratchpad every chance to
        // (incorrectly) bypass the per-notebook lock before asserting that
        // exactly one command went out.
        yield* Effect.yieldNow;

        const first_ = scratchpadCalls(yield* ctx.executions);
        expect(first_).toHaveLength(1);
        const firstCommand = first_[0];
        assert(
          firstCommand !== undefined && typeof firstCommand.runId === "string",
        );

        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: {
            op: "completed-run",
            run_id: firstCommand.runId,
          },
        });

        // Await the second command the same way: the released scratchpad may
        // need several drains to acquire the lock and send its command.
        const commands = scratchpadCalls(
          yield* ctx.executionChanges.pipe(
            Stream.filter((calls) => scratchpadCalls(calls).length >= 2),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );
        expect(commands).toHaveLength(2);
        const secondCommand = commands[1];
        assert(
          secondCommand !== undefined &&
            typeof secondCommand.runId === "string",
        );

        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: {
            op: "completed-run",
            run_id: secondCommand.runId,
          },
        });

        yield* Fiber.join(first);
        yield* Fiber.join(second);
      });
    }),
  );

  it.effect(
    "allows scratchpad execution in separate notebooks",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;
      const otherEditor = TestVsCode.makeNotebookEditor(
        NodePath.join(process.cwd(), "other_notebook_mo.py"),
      );
      const otherNotebook = MarimoNotebookDocument.from(otherEditor.notebook);

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;
        // No drain needed before the open: the document-session service acquires its
        // lifecycle subscription before its layer finishes building, so an
        // open published this early is delivered rather than dropped.
        yield* ctx.vscode.openNotebook(otherEditor.notebook);
        yield* Effect.yieldNow;
        yield* ctx.attachController(otherNotebook.id);
        const firstNotebook = yield* runtime.forNotebook(ctx.notebookUri);
        const secondNotebook = yield* runtime.forNotebook(otherNotebook.id);

        const first = yield* Effect.forkChild(
          firstNotebook
            .executeScratchpad("print('first')")
            .pipe(Stream.runDrain),
        );
        const second = yield* Effect.forkChild(
          secondNotebook
            .executeScratchpad("print('second')")
            .pipe(Stream.runDrain),
        );

        const executions = yield* ctx.executionChanges.pipe(
          Stream.filter(
            (calls) =>
              calls.filter((call) => call.kind === "execute-scratchpad")
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
          if (command.kind === "execute-scratchpad") {
            assert(typeof command.runId === "string");
            commands.push({
              notebookUri: notebookId(command.notebookUri),
              runId: command.runId,
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
          yield* ctx.publishOperation({
            notebookUri: command.notebookUri,
            sessionId: ACTIVE_SESSION_ID,
            notification: {
              op: "completed-run",
              run_id: command.runId,
            },
          });
        }

        yield* Fiber.join(first);
        yield* Fiber.join(second);
      });
    }),
  );

  it.effect(
    "streams scratch + cascade console ops until the matching completed-run",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;

        // Route cell-op notifications through processSessionOperation.
        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);

        const streamFiber = yield* Effect.forkChild(
          notebook.executeScratchpad("print('hi')").pipe(Stream.runCollect),
        );

        // Wait for executeScratchpad to enqueue its private command with its generated
        // runId instead of relying on a scheduler tick.
        const executions = yield* ctx.executionChanges.pipe(
          Stream.filter((calls) =>
            calls.some((call) => call.kind === "execute-scratchpad"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const executeCmd = executions.find(
          (c) => c.kind === "execute-scratchpad",
        );

        assert(executeCmd !== undefined);
        const { runId } = executeCmd;
        expect(runId).toBeDefined();

        const cell = ctx.notebook.cellAt(0);
        const realCellId = Option.getOrThrow(cell.id);

        // The scratch cell's op carries the run's output. marimo leaves its
        // run_id null (only the completed-run echoes ours), so we key on the
        // SCRATCH_CELL_ID, not the run_id.
        yield* ctx.publishOperation(
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
        yield* ctx.publishOperation(
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
        yield* ctx.publishOperation(
          makeIdleCellOperation(ctx.notebookUri, realCellId, {
            status: "idle",
          }),
        );

        // Our completed-run ends the stream (inclusive; filtered back out).
        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: {
            op: "completed-run",
            run_id: runId,
          },
        });

        const ops = yield* Fiber.join(streamFiber);
        const cellIds = ops.map((op) => op.cell_id);
        expect(ops).toHaveLength(2);
        expect(cellIds).toContain(SCRATCH_CELL_ID);
        expect(cellIds).toContain(realCellId);
      });
    }),
  );

  it.effect(
    "interrupts the kernel when the stream is abandoned before completed-run",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);

        const streamFiber = yield* Effect.forkChild(
          notebook.executeScratchpad("print('hi')").pipe(Stream.runCollect),
        );

        // Wait until executeScratchpad sends the command and arms the
        // interrupt-on-abandon finalizer instead of relying on a scheduler
        // tick.
        yield* ctx.executionChanges.pipe(
          Stream.filter((calls) =>
            calls.some((call) => call.kind === "execute-scratchpad"),
          ),
          Stream.runHead,
        );

        // Abandon the stream before any completed-run arrives (mirrors a
        // cancelled tool invocation interrupting the fiber).
        yield* Fiber.interrupt(streamFiber);

        const executions = yield* ctx.executions;

        const executeCmd = executions.find(
          (c) => c.kind === "execute-scratchpad",
        );
        assert(executeCmd !== undefined);
        const { runId } = executeCmd;

        // The finalizer should have sent a run-correlated interrupt. The
        // server uses the id to remember cancellation during kernel startup.
        const interruptCmd = executions.find((c) => c.kind === "interrupt");

        expect(interruptCmd).toMatchObject({
          kind: "interrupt",
          runId,
          notebookUri: ctx.notebookUri,
        });
      });
    }),
  );

  it.effect(
    "does not interrupt the kernel after a normal completed-run",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;

        yield* ctx.vscode.setActiveNotebookEditor(Option.some(ctx.editor));
        yield* Effect.yieldNow;
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);

        const streamFiber = yield* Effect.forkChild(
          notebook.executeScratchpad("print('hi')").pipe(Stream.runCollect),
        );

        // Wait until the command is recorded. Do not count scheduler
        // drains. The scratchpad setup can need more than one drain, which
        // makes a single scheduler yield flaky.
        const calls = yield* ctx.executionChanges.pipe(
          Stream.filter((current) =>
            current.some((call) => call.kind === "execute-scratchpad"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const executeCmd = calls.find((c) => c.kind === "execute-scratchpad");
        assert(executeCmd !== undefined);
        const { runId } = executeCmd;

        // Our completed-run ends the stream normally.
        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: { op: "completed-run", run_id: runId },
        });

        yield* Fiber.join(streamFiber);

        const interruptCmd = (yield* ctx.executions).find(
          (c) => c.kind === "interrupt",
        );
        expect(interruptCmd).toBeUndefined();
      });
    }),
  );
});

describe("NotebookRuntime state eviction", () => {
  it.effect(
    "ignores operations from a replaced kernel session",
    Effect.fn(function* () {
      const activeSessionId = ACTIVE_SESSION_ID;
      const staleSessionId = kernelSessionId(
        "00000000-0000-4000-8000-000000000002",
      );
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;
        const variables = yield* NotebookVariables.Service;
        yield* Effect.yieldNow;

        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: staleSessionId,
          notification: { op: "variables", variables: [] },
        });
        yield* Effect.yieldNow;
        expect(
          Option.isNone(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);

        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: activeSessionId,
          notification: { op: "variables", variables: [] },
        });
        yield* variables.getVariables(ctx.notebookUri).pipe(
          Effect.filterOrFail(Option.isSome, () => "variables not settled"),
          Effect.eventually,
        );
      });
    }),
  );

  it.effect(
    "evicts variables and datasource state when a notebook closes",
    Effect.fn(function* () {
      const ctx = yield* TestNotebookRuntime.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;
        const variables = yield* NotebookVariables.Service;
        const datasources = yield* NotebookDatasources.Service;

        // One scheduler drain so NotebookRuntime's forked operations pipeline
        // subscribes to the mock PubSub before we publish (forked fibers only
        // start once the test fiber yields; a publish before that is silently
        // dropped since the PubSub has no replay). In production, operations
        // only flow for sessions started via this same runtime, so nothing
        // can be published before the pipeline subscribes.
        yield* Effect.yieldNow;

        yield* ctx.publishAnalysis({
          notebookUri: ctx.notebookUri,
          analysis: {
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
        yield* ctx.publishOperation({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: { op: "datasets", tables: [] },
        });
        yield* Effect.all([
          variables.getVariables(ctx.notebookUri),
          datasources.getDatasets(ctx.notebookUri),
        ]).pipe(
          Effect.filterOrFail(
            ([currentVariables, currentDatasets]) =>
              Option.isSome(currentVariables) && Option.isSome(currentDatasets),
            () => "runtime projections not settled" as const,
          ),
          Effect.eventually,
        );

        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);
        expect(
          Option.isSome(yield* datasources.getDatasets(ctx.notebookUri)),
        ).toBe(true);

        yield* ctx.vscode.closeNotebook(ctx.editor.notebook);
        yield* Effect.all([
          variables.getVariables(ctx.notebookUri),
          datasources.getDatasets(ctx.notebookUri),
        ]).pipe(
          Effect.filterOrFail(
            ([currentVariables, currentDatasets]) =>
              Option.isNone(currentVariables) && Option.isNone(currentDatasets),
            () => "runtime projections not evicted" as const,
          ),
          Effect.eventually,
        );

        // Notifications already queued, or delivered late by the old kernel
        // session, must not recreate state after eviction.
        yield* ctx.publishAnalysis({
          notebookUri: ctx.notebookUri,
          analysis: {
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
        yield* Effect.yieldNow;
        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(false);

        // Reopening creates a distinct document session at the same URI.
        const replacement = TestVsCode.createTestNotebookDocument(
          ctx.editor.notebook.uri,
          { notebookType: ctx.editor.notebook.notebookType },
        );
        yield* ctx.vscode.openNotebook(replacement);
        yield* Effect.gen(function* () {
          yield* ctx.publishAnalysis({
            notebookUri: ctx.notebookUri,
            analysis: { op: "variables", variables: [] },
          });
          return yield* variables.getVariables(ctx.notebookUri);
        }).pipe(
          Effect.filterOrFail(
            Option.isSome,
            () => "replacement session not ready" as const,
          ),
          Effect.eventually,
        );
        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);

        // A delayed close from the old document must not clear replacement
        // session state.
        yield* ctx.vscode.closeNotebook(ctx.editor.notebook);
        // Opening a marker document on the same sequential lifecycle stream
        // gives the stale close an observable ordering barrier. Once the
        // marker has a session, the preceding close has been handled.
        const lifecycleMarker = TestVsCode.createTestNotebookDocument(
          NodePath.join(process.cwd(), "lifecycle-marker_mo.py"),
        );
        yield* ctx.vscode.openNotebook(lifecycleMarker);
        yield* settle(
          runtime.forDocument(lifecycleMarker).pipe(Effect.option),
          Option.isSome,
          "notebook lifecycle pipeline did not settle",
        );
        expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);
      });
    }),
  );
});
