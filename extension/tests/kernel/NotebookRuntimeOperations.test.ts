import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import {
  Cause,
  Effect,
  Exit,
  Fiber,
  HashMap,
  Latch,
  Option,
  Ref,
  Stream,
} from "effect";

import { SCRATCH_CELL_ID } from "../../src/constants.ts";
import { makeNotebookExecutor } from "../../src/kernel/NotebookExecutor.ts";
import * as NotebookRuntime from "../../src/kernel/NotebookRuntime.ts";
import * as NotebookDatasources from "../../src/panel/datasources/NotebookDatasources.ts";
import * as NotebookVariables from "../../src/panel/variables/NotebookVariables.ts";
import {
  MarimoNotebookDocument,
  type NotebookId,
} from "../../src/schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  KernelNotification,
} from "../../src/types.ts";
import * as MarimoClientTest from "../fake/MarimoClient.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as VsCodeValues from "../fake/VsCodeValues.ts";
import {
  cellId,
  kernelSessionId,
  notebookId,
  variableName,
} from "../lib/branded.ts";
import * as EffectTest from "../lib/EffectTest.ts";
import * as NotebookRuntimeHarness from "./notebookRuntimeHarness.ts";

const ACTIVE_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000001",
);
const it = EffectTest.make(NotebookRuntimeHarness.layer);
const cancellationIt = EffectTest.make(
  NotebookRuntimeHarness.layerWith({ suspendWorkspaceEdits: true }),
);

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

Vitest.describe("NotebookRuntime operation processing", () => {
  Vitest.it.effect(
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

      Vitest.assert.deepStrictEqual(yield* Ref.get(processed), [
        "one",
        "two",
        "three",
      ]);
    }),
  );

  Vitest.it.effect(
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

      Vitest.assert.deepStrictEqual(yield* Ref.get(processed), [
        "blocker",
        "settle",
        "serialization",
      ]);
    }),
  );

  Vitest.it.effect(
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
      Vitest.assert.deepStrictEqual(yield* Ref.get(processed), ["b-1"]);

      yield* releaseFirst.open;
      yield* secondProcessed.await;

      Vitest.assert.deepStrictEqual(yield* Ref.get(processed), [
        "b-1",
        "a-1",
        "a-2",
      ]);
    }),
  );

  cancellationIt.effect(
    "does not report session cancellation as an operation failure",
    Effect.fn(function* () {
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;
      const vscode = yield* VsCodeTest.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;
        yield* NotebookRuntimeHarness.activate(ctx.editor);

        yield* marimo.publishNotification({
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
        yield* ctx.workspaceEditStarted.await;

        yield* NotebookRuntimeHarness.close(ctx.editor.notebook);

        Vitest.expect((yield* vscode.snapshot).errorMessages).toEqual([]);
      });
    }),
  );
});

Vitest.describe("NotebookRuntime cell identity", () => {
  it.effect(
    "notifies marimo when a cell is deleted",
    Effect.fn(function* () {
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;

        const cell = ctx.editor.notebook.cellAt(0);
        yield* NotebookRuntimeHarness.changeNotebook({
          notebook: ctx.editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new VsCodeValues.NotebookRange(0, 1),
              removedCells: [cell],
              addedCells: [],
            },
          ],
        });
        const executions = yield* marimo.commandChanges.pipe(
          Stream.filter((commands) =>
            commands.some((command) => command.kind === "delete-cell"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        Vitest.expect(executions).toContainEqual({
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
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;

        const cell = ctx.editor.notebook.cellAt(0);
        yield* NotebookRuntimeHarness.changeNotebook({
          notebook: ctx.editor.notebook,
          metadata: undefined,
          cellChanges: [],
          contentChanges: [
            {
              range: new VsCodeValues.NotebookRange(0, 1),
              removedCells: [cell],
              addedCells: [],
            },
            {
              range: new VsCodeValues.NotebookRange(1, 1),
              removedCells: [],
              addedCells: [cell],
            },
          ],
        });

        // This exact move has completed, including the no-deletion path.
        const commands = yield* marimo.commands;

        Vitest.expect(
          commands.some(
            (command) =>
              command.kind === "delete-cell" && command.cellId === "cell-1",
          ),
        ).toBe(false);
      });
    }),
  );
});

Vitest.describe("NotebookRuntime stdin", () => {
  it.effect(
    "prompts for input on stdin cell-op and sends response",
    Effect.fn(function* () {
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;
      const vscode = yield* VsCodeTest.Service;

      yield* Effect.gen(function* () {
        const cell = ctx.notebook.cellAt(0);
        const cellId = Option.getOrThrow(cell.id);

        // Set active editor so NotebookEditorRegistry can find it
        yield* NotebookRuntimeHarness.activate(ctx.editor);

        // Push a cell-op with stdin console output
        yield* marimo.publishNotification(
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
        yield* NotebookRuntimeHarness.inputRequested;

        // Provide the input (unblocks showInputBox)
        yield* vscode.respondToInput(Option.some("foo"));

        // Assert executeCommand was called with send-stdin
        const observed = yield* marimo.commandChanges.pipe(
          Stream.filter((calls) =>
            calls.some((call) => call.kind === "send-stdin"),
          ),
          Stream.runHead,
        );
        const cmds = Option.getOrThrow(observed);
        const stdinCmd = cmds.find((c) => c.kind === "send-stdin");
        Vitest.expect(stdinCmd).toMatchObject({
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
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;
      const vscode = yield* VsCodeTest.Service;

      yield* Effect.gen(function* () {
        const cell = ctx.notebook.cellAt(0);
        const cellId = Option.getOrThrow(cell.id);

        yield* NotebookRuntimeHarness.activate(ctx.editor);

        yield* marimo.publishNotification(
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
        yield* NotebookRuntimeHarness.inputRequested;

        // User cancels the input box
        yield* vscode.respondToInput(Option.none());
        const cmds = yield* marimo.commandChanges.pipe(
          Stream.filter((calls) =>
            calls.some((call) => call.kind === "interrupt"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );

        // No send-stdin command should have been sent
        const stdinCmd = cmds.find((c) => c.kind === "send-stdin");
        Vitest.expect(stdinCmd).toBeUndefined();

        // An interrupt should have been sent instead
        const interruptCmd = cmds.find((c) => c.kind === "interrupt");
        Vitest.expect(interruptCmd).toMatchObject({
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
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;
      const vscode = yield* VsCodeTest.Service;

      yield* Effect.gen(function* () {
        const cellId = Option.getOrThrow(ctx.notebook.cellAt(0).id);
        yield* NotebookRuntimeHarness.activate(ctx.editor);

        yield* marimo.publishNotification(
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
        yield* NotebookRuntimeHarness.inputRequested;

        yield* vscode.closeNotebook(ctx.editor.notebook);
        yield* NotebookRuntimeHarness.inputCancelled;

        Vitest.expect(
          (yield* marimo.commands).some(
            (command) => command.kind === "send-stdin",
          ),
        ).toBe(false);
      });
    }),
  );

  it.effect(
    "does not send an old prompt response to a replacement kernel",
    Effect.fn(function* () {
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;
      const vscode = yield* VsCodeTest.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;
        const cellId = Option.getOrThrow(ctx.notebook.cellAt(0).id);
        yield* NotebookRuntimeHarness.activate(ctx.editor);

        yield* marimo.publishNotification(
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
        yield* NotebookRuntimeHarness.inputRequested;

        const notebook = yield* runtime.forNotebook(ctx.notebookUri);
        yield* notebook.restart;
        const progress = yield* runtime.subscribeInputProgress;
        const response = Option.some("stale response");
        yield* vscode.respondToInput(response);
        const handled = yield* progress.pipe(
          Stream.filter(
            (
              event,
            ): event is Extract<
              NotebookRuntime.InputProgress,
              { _tag: "StdinResponded" }
            > => event._tag === "StdinResponded" && event.result === response,
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        Vitest.assert(Exit.isFailure(handled.exit));
        Vitest.expect(Cause.squash(handled.exit.cause)).toBeInstanceOf(
          NotebookRuntime.NoActiveKernelError,
        );

        Vitest.expect(
          (yield* marimo.commands).some(
            (command) => command.kind === "send-stdin",
          ),
        ).toBe(false);
      });
    }),
  );
});

Vitest.describe("NotebookRuntime scratch stream", () => {
  it.effect(
    "runs one scratchpad at a time within a notebook",
    Effect.fn(function* () {
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);
        const progress = yield* runtime.subscribeInputProgress;
        const first = yield* Effect.forkChild(
          notebook.executeScratchpad("print('first')").pipe(Stream.runDrain),
        );

        const scratchpadCalls = (
          calls: ReadonlyArray<MarimoClientTest.Command>,
        ) => calls.filter((call) => call.kind === "execute-scratchpad");

        yield* marimo.commandChanges.pipe(
          Stream.filter((calls) => scratchpadCalls(calls).length >= 1),
          Stream.runHead,
        );
        const second = yield* Effect.forkChild(
          notebook.executeScratchpad("print('second')").pipe(Stream.runDrain),
        );
        yield* progress.pipe(
          Stream.filter(
            (event) =>
              event._tag === "ScratchpadQueued" &&
              event.notebookId === ctx.notebookUri &&
              event.code === "print('second')",
          ),
          Stream.runHead,
        );

        const first_ = scratchpadCalls(yield* marimo.commands);
        Vitest.expect(first_).toHaveLength(1);
        const firstCommand = first_[0];
        Vitest.assert(
          firstCommand !== undefined && typeof firstCommand.runId === "string",
        );

        yield* marimo.publishNotification({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: {
            op: "completed-run",
            run_id: firstCommand.runId,
          },
        });

        const commands = scratchpadCalls(
          yield* marimo.commandChanges.pipe(
            Stream.filter((calls) => scratchpadCalls(calls).length >= 2),
            Stream.runHead,
            Effect.map(Option.getOrThrow),
          ),
        );
        Vitest.expect(commands).toHaveLength(2);
        const secondCommand = commands[1];
        Vitest.assert(
          secondCommand !== undefined &&
            typeof secondCommand.runId === "string",
        );

        yield* marimo.publishNotification({
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
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;
      const otherEditor = VsCodeValues.makeNotebookEditor(
        NodePath.join(process.cwd(), "other_notebook_mo.py"),
      );
      const otherNotebook = MarimoNotebookDocument.from(otherEditor.notebook);

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;
        yield* NotebookRuntimeHarness.open(otherEditor);
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

        const executions = yield* marimo.commandChanges.pipe(
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
            Vitest.assert(typeof command.runId === "string");
            commands.push({
              notebookUri: notebookId(command.notebookUri),
              runId: command.runId,
            });
          }
        }
        Vitest.expect(
          commands
            .map((command) => command.notebookUri)
            .toSorted((a, b) => a.localeCompare(b)),
        ).toEqual(
          [ctx.notebookUri, otherNotebook.id].toSorted((a, b) =>
            a.localeCompare(b),
          ),
        );

        for (const command of commands) {
          yield* marimo.publishNotification({
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
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;

        // Route cell-op notifications through processSessionOperation.
        yield* NotebookRuntimeHarness.activate(ctx.editor);
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);

        const streamFiber = yield* Effect.forkChild(
          notebook.executeScratchpad("print('hi')").pipe(Stream.runCollect),
        );

        // Wait for executeScratchpad to enqueue its private command with its generated
        // runId instead of relying on a scheduler tick.
        const executions = yield* marimo.commandChanges.pipe(
          Stream.filter((calls) =>
            calls.some((call) => call.kind === "execute-scratchpad"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const executeCmd = executions.find(
          (c) => c.kind === "execute-scratchpad",
        );

        Vitest.assert(executeCmd !== undefined);
        const { runId } = executeCmd;
        Vitest.expect(runId).toBeDefined();

        const cell = ctx.notebook.cellAt(0);
        const realCellId = Option.getOrThrow(cell.id);

        // The scratch cell's op carries the run's output. marimo leaves its
        // run_id null (only the completed-run echoes ours), so we key on the
        // SCRATCH_CELL_ID, not the run_id.
        yield* marimo.publishNotification(
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
        yield* marimo.publishNotification(
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
        yield* marimo.publishNotification(
          makeIdleCellOperation(ctx.notebookUri, realCellId, {
            status: "idle",
          }),
        );

        // Our completed-run ends the stream (inclusive; filtered back out).
        yield* marimo.publishNotification({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: {
            op: "completed-run",
            run_id: runId,
          },
        });

        const ops = yield* Fiber.join(streamFiber);
        const cellIds = ops.map((op) => op.cell_id);
        Vitest.expect(ops).toHaveLength(2);
        Vitest.expect(cellIds).toContain(SCRATCH_CELL_ID);
        Vitest.expect(cellIds).toContain(realCellId);
      });
    }),
  );

  it.effect(
    "interrupts the kernel when the stream is abandoned before completed-run",
    Effect.fn(function* () {
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;

        yield* NotebookRuntimeHarness.activate(ctx.editor);
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);

        const streamFiber = yield* Effect.forkChild(
          notebook.executeScratchpad("print('hi')").pipe(Stream.runCollect),
        );

        // Wait until executeScratchpad sends the command and arms the
        // interrupt-on-abandon finalizer instead of relying on a scheduler
        // tick.
        yield* marimo.commandChanges.pipe(
          Stream.filter((calls) =>
            calls.some((call) => call.kind === "execute-scratchpad"),
          ),
          Stream.runHead,
        );

        // Abandon the stream before any completed-run arrives (mirrors a
        // cancelled tool invocation interrupting the fiber).
        yield* Fiber.interrupt(streamFiber);

        const executions = yield* marimo.commands;

        const executeCmd = executions.find(
          (c) => c.kind === "execute-scratchpad",
        );
        Vitest.assert(executeCmd !== undefined);
        const { runId } = executeCmd;

        // The finalizer should have sent a run-correlated interrupt. The
        // server uses the id to remember cancellation during kernel startup.
        const interruptCmd = executions.find((c) => c.kind === "interrupt");

        Vitest.expect(interruptCmd).toMatchObject({
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
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        const runtime = yield* NotebookRuntime.Service;

        yield* NotebookRuntimeHarness.activate(ctx.editor);
        const notebook = yield* runtime.forNotebook(ctx.notebookUri);

        const streamFiber = yield* Effect.forkChild(
          notebook.executeScratchpad("print('hi')").pipe(Stream.runCollect),
        );

        // Wait until the command is recorded. Do not count scheduler
        // drains. The scratchpad setup can need more than one drain, which
        // makes a single scheduler yield flaky.
        const calls = yield* marimo.commandChanges.pipe(
          Stream.filter((current) =>
            current.some((call) => call.kind === "execute-scratchpad"),
          ),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        const executeCmd = calls.find((c) => c.kind === "execute-scratchpad");
        Vitest.assert(executeCmd !== undefined);
        const { runId } = executeCmd;

        // Our completed-run ends the stream normally.
        yield* marimo.publishNotification({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: { op: "completed-run", run_id: runId },
        });

        yield* Fiber.join(streamFiber);

        const interruptCmd = (yield* marimo.commands).find(
          (c) => c.kind === "interrupt",
        );
        Vitest.expect(interruptCmd).toBeUndefined();
      });
    }),
  );
});

Vitest.describe("NotebookRuntime state eviction", () => {
  it.effect(
    "ignores operations from a replaced kernel session",
    Effect.fn(function* () {
      const activeSessionId = ACTIVE_SESSION_ID;
      const staleSessionId = kernelSessionId(
        "00000000-0000-4000-8000-000000000002",
      );
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;
        const variables = yield* NotebookVariables.Service;

        const refreshes = (commands: ReadonlyArray<MarimoClientTest.Command>) =>
          commands.filter((command) => command.kind === "list-sessions").length;
        const before = refreshes(yield* marimo.commands);
        const refreshed = yield* marimo.commandChanges.pipe(
          Stream.filter((commands) => refreshes(commands) > before),
          Stream.runHead,
          Effect.forkChild({ startImmediately: true }),
        );
        yield* marimo.publishNotification({
          notebookUri: ctx.notebookUri,
          sessionId: staleSessionId,
          notification: { op: "variables", variables: [] },
        });
        yield* Fiber.join(refreshed);
        Vitest.expect(
          Option.isNone(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);

        yield* marimo.publishNotification({
          notebookUri: ctx.notebookUri,
          sessionId: activeSessionId,
          notification: { op: "variables", variables: [] },
        });
        yield* variables.streamVariablesChanges.pipe(
          Stream.filter(HashMap.has(ctx.notebookUri)),
          Stream.runHead,
        );
      });
    }),
  );

  it.effect(
    "evicts variables and datasource state when a notebook closes",
    Effect.fn(function* () {
      const ctx = yield* NotebookRuntimeHarness.Notebook;
      const marimo = yield* MarimoClientTest.Service;

      yield* Effect.gen(function* () {
        yield* NotebookRuntime.Service;
        const variables = yield* NotebookVariables.Service;
        const datasources = yield* NotebookDatasources.Service;

        yield* NotebookRuntimeHarness.publishAnalysis({
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
        yield* marimo.publishNotification({
          notebookUri: ctx.notebookUri,
          sessionId: ACTIVE_SESSION_ID,
          notification: { op: "datasets", tables: [] },
        });
        yield* Effect.all([
          variables.streamVariablesChanges.pipe(
            Stream.filter(HashMap.has(ctx.notebookUri)),
            Stream.runHead,
          ),
          datasources.streamDatasetsChanges.pipe(
            Stream.filter(HashMap.has(ctx.notebookUri)),
            Stream.runHead,
          ),
        ]);

        Vitest.expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);
        Vitest.expect(
          Option.isSome(yield* datasources.getDatasets(ctx.notebookUri)),
        ).toBe(true);

        yield* NotebookRuntimeHarness.close(ctx.editor.notebook);
        Vitest.expect(yield* variables.getVariables(ctx.notebookUri)).toEqual(
          Option.none(),
        );
        Vitest.expect(yield* datasources.getDatasets(ctx.notebookUri)).toEqual(
          Option.none(),
        );

        // Notifications already queued, or delivered late by the old kernel
        // session, must not recreate state after eviction.
        yield* NotebookRuntimeHarness.publishAnalysis({
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

        // Publishing waits for this analysis to be dispatched or discarded.
        Vitest.expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(false);

        // Reopening creates a distinct document session at the same URI.
        const replacement = VsCodeValues.createTestNotebookEditor(
          VsCodeValues.createTestNotebookDocument(ctx.editor.notebook.uri, {
            notebookType: ctx.editor.notebook.notebookType,
          }),
        );
        yield* NotebookRuntimeHarness.open(replacement);
        yield* NotebookRuntimeHarness.publishAnalysis({
          notebookUri: ctx.notebookUri,
          analysis: { op: "variables", variables: [] },
        });
        yield* variables.streamVariablesChanges.pipe(
          Stream.filter(HashMap.has(ctx.notebookUri)),
          Stream.runHead,
        );
        Vitest.expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);

        // A delayed close from the old document must not clear replacement
        // session state.
        yield* NotebookRuntimeHarness.close(ctx.editor.notebook);
        Vitest.expect(
          Option.isSome(yield* variables.getVariables(ctx.notebookUri)),
        ).toBe(true);
      });
    }),
  );
});
