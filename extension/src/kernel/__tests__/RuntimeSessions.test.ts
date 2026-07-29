import { assert, describe, expect, it } from "@effect/vitest";
import {
  Chunk,
  Deferred,
  Effect,
  Either,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
  TestClock,
} from "effect";

import { SCRATCH_CELL_ID } from "../../constants.ts";
import {
  base64String,
  cellId,
  notebookId,
  requestId,
  uiElementId,
  widgetModelId,
} from "../../lib/__tests__/branded.ts";
import { LanguageClient } from "../../lsp/LanguageClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  MarimoCommand,
  Notification,
} from "../../types.ts";
import { RuntimeCommandQueueClosedError } from "../RuntimeCommandQueue.ts";
import { type MarimoOperation, RuntimeSessions } from "../RuntimeSessions.ts";

const NOTEBOOK_A = notebookId("notebook-a");
const NOTEBOOK_B = notebookId("notebook-b");

const completedRun = (
  notebookUri: NotebookId,
  runId: string,
): MarimoOperation => ({
  notebookUri,
  operation: {
    op: "completed-run",
    run_id: runId,
  },
});

const cellOperation = (
  notebookUri: NotebookId,
  id: string,
  overrides: Partial<CellOperationNotification> = {},
): MarimoOperation => ({
  notebookUri,
  operation: {
    op: "cell-op",
    cell_id: cellId(id),
    status: "idle",
    ...overrides,
  },
});

const withTestContext = Effect.fn(function* (
  onSend: (command: MarimoCommand) => Effect.Effect<void> = () => Effect.void,
) {
  const source = yield* PubSub.unbounded<MarimoOperation>();
  const rawSubscriptions = yield* Ref.make(0);
  const sentCommands = yield* Ref.make<ReadonlyArray<MarimoCommand>>([]);

  const client = Layer.succeed(
    LanguageClient,
    LanguageClient.make({
      channel: { name: "marimo-lsp", show() {} },
      restart: () => Effect.void,
      executeCommand: (command: MarimoCommand) =>
        Ref.update(sentCommands, (commands) => [...commands, command]).pipe(
          Effect.andThen(onSend(command)),
        ),
      streamOf() {
        const stream = Stream.unwrap(
          Ref.updateAndGet(rawSubscriptions, (count) => count + 1).pipe(
            Effect.as(Stream.fromPubSub(source)),
          ),
        );
        // SAFETY: this fake only serves the marimo/operation stream used by
        // RuntimeSessions.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        return stream as never;
      },
    }),
  );

  return {
    source,
    rawSubscriptions,
    sentCommands,
    layer: RuntimeSessions.Default.pipe(Layer.provide(client)),
  };
});

const runIds = (
  operations: Chunk.Chunk<Notification>,
): ReadonlyArray<string | null | undefined> =>
  Chunk.toReadonlyArray(operations)
    .filter((operation) => operation.op === "completed-run")
    .map((operation) => operation.run_id);

type MarimoApiCommand = Extract<MarimoCommand, { command: "marimo.api" }>;
type ScratchpadCommand = MarimoApiCommand & {
  readonly params: Extract<
    MarimoApiCommand["params"],
    { method: "execute-scratchpad" }
  >;
};

const marimoApiCommands = (
  commands: ReadonlyArray<MarimoCommand>,
): ReadonlyArray<MarimoApiCommand> =>
  commands.filter(
    (command): command is MarimoApiCommand => command.command === "marimo.api",
  );

const scratchpadCommands = (
  commands: ReadonlyArray<MarimoCommand>,
): ReadonlyArray<ScratchpadCommand> =>
  marimoApiCommands(commands).filter(
    (command): command is ScratchpadCommand =>
      command.params.method === "execute-scratchpad",
  );

const apiMethods = (
  commands: ReadonlyArray<MarimoCommand>,
): ReadonlyArray<MarimoApiCommand["params"]["method"]> =>
  marimoApiCommands(commands).map((command) => command.params.method);

describe("RuntimeSessions", () => {
  it.scoped(
    "routes operations to the matching session in order",
    Effect.fn(function* () {
      const ctx = yield* withTestContext();

      yield* Effect.gen(function* () {
        const sessions = yield* RuntimeSessions;
        const sessionA = yield* sessions.getOrCreate(NOTEBOOK_A);
        const sameSessionA = yield* sessions.getOrCreate(NOTEBOOK_A);
        const sessionB = yield* sessions.getOrCreate(NOTEBOOK_B);
        expect(sameSessionA).toBe(sessionA);

        const operationsA = yield* sessionA
          .operations()
          .pipe(Stream.take(2), Stream.runCollect, Effect.fork);
        const operationsB = yield* sessionB
          .operations()
          .pipe(Stream.take(1), Stream.runCollect, Effect.fork);
        yield* TestClock.adjust("1 millis");

        yield* PubSub.publish(ctx.source, completedRun(NOTEBOOK_A, "a-1"));
        yield* PubSub.publish(ctx.source, completedRun(NOTEBOOK_B, "b-1"));
        yield* PubSub.publish(ctx.source, completedRun(NOTEBOOK_A, "a-2"));

        assert.deepStrictEqual(runIds(yield* Fiber.join(operationsA)), [
          "a-1",
          "a-2",
        ]);
        assert.deepStrictEqual(runIds(yield* Fiber.join(operationsB)), ["b-1"]);
        assert.strictEqual(yield* Ref.get(ctx.rawSubscriptions), 1);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "streams scratchpad output until its completed run",
    Effect.fn(function* () {
      const ctx = yield* withTestContext();

      yield* Effect.gen(function* () {
        const session = yield* (yield* RuntimeSessions).getOrCreate(NOTEBOOK_A);
        const execution = yield* session
          .executeScratchpad("print('hi')", "/usr/bin/python")
          .pipe(Stream.runCollect, Effect.fork);
        yield* TestClock.adjust("1 millis");

        const command = scratchpadCommands(yield* Ref.get(ctx.sentCommands))[0];
        assert(command !== undefined);
        const runId = command.params.params.inner.runId;
        assert(runId !== undefined);

        yield* PubSub.publish(
          ctx.source,
          cellOperation(NOTEBOOK_A, SCRATCH_CELL_ID, {
            console: [
              {
                channel: "stdout",
                data: "scratch",
                mimetype: "text/plain",
                timestamp: 0,
              },
            ],
          }),
        );
        yield* PubSub.publish(
          ctx.source,
          cellOperation(NOTEBOOK_A, "cascade", {
            console: [
              {
                channel: "stderr",
                data: "cascade",
                mimetype: "text/plain",
                timestamp: 0,
              },
            ],
          }),
        );
        yield* PubSub.publish(
          ctx.source,
          cellOperation(NOTEBOOK_A, "status-only"),
        );
        yield* PubSub.publish(
          ctx.source,
          completedRun(NOTEBOOK_A, "other-run"),
        );
        yield* PubSub.publish(ctx.source, completedRun(NOTEBOOK_A, runId));

        assert.deepStrictEqual(
          Chunk.toReadonlyArray(yield* Fiber.join(execution)).map(
            (operation) => operation.cell_id,
          ),
          [SCRATCH_CELL_ID, cellId("cascade")],
        );
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "serializes scratchpads within a session but not across sessions",
    Effect.fn(function* () {
      const ctx = yield* withTestContext();

      yield* Effect.gen(function* () {
        const sessions = yield* RuntimeSessions;
        const sessionA = yield* sessions.getOrCreate(NOTEBOOK_A);
        const sessionB = yield* sessions.getOrCreate(NOTEBOOK_B);

        const a1 = yield* sessionA
          .executeScratchpad("a1", "/usr/bin/python")
          .pipe(Stream.runDrain, Effect.fork);
        const a2 = yield* sessionA
          .executeScratchpad("a2", "/usr/bin/python")
          .pipe(Stream.runDrain, Effect.fork);
        const b1 = yield* sessionB
          .executeScratchpad("b1", "/usr/bin/python")
          .pipe(Stream.runDrain, Effect.fork);
        yield* TestClock.adjust("1 millis");

        const firstCommands = scratchpadCommands(
          yield* Ref.get(ctx.sentCommands),
        );
        expect(firstCommands).toHaveLength(2);

        const firstA = firstCommands.find(
          ({ params }) => params.params.notebookUri === NOTEBOOK_A,
        );
        const firstB = firstCommands.find(
          ({ params }) => params.params.notebookUri === NOTEBOOK_B,
        );
        assert(firstA !== undefined);
        assert(firstB !== undefined);

        yield* PubSub.publish(
          ctx.source,
          completedRun(NOTEBOOK_A, firstA.params.params.inner.runId ?? ""),
        );
        yield* PubSub.publish(
          ctx.source,
          completedRun(NOTEBOOK_B, firstB.params.params.inner.runId ?? ""),
        );
        yield* Fiber.join(a1);
        yield* Fiber.join(b1);
        yield* TestClock.adjust("1 millis");

        const commands = scratchpadCommands(yield* Ref.get(ctx.sentCommands));
        expect(commands).toHaveLength(3);
        const secondA = commands[2];
        assert(secondA !== undefined);
        expect(secondA.params.params.inner.code).toBe("a2");

        yield* PubSub.publish(
          ctx.source,
          completedRun(NOTEBOOK_A, secondA.params.params.inner.runId ?? ""),
        );
        yield* Fiber.join(a2);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "merges pending UI element values by ID",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const slider = uiElementId("slider");
      const other = uiElementId("other");
      const ctx = yield* withTestContext(
        Effect.fn(function* (command) {
          if (
            command.command !== "marimo.api" ||
            command.params.method !== "update-ui-element"
          ) {
            return;
          }
          const value = command.params.params.inner.values[0];
          if (value === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          } else {
            yield* Deferred.succeed(secondStarted, undefined);
          }
        }),
      );

      yield* Effect.gen(function* () {
        const sessions = yield* RuntimeSessions;
        const session = yield* sessions.getOrCreate(NOTEBOOK_A);

        yield* session.updateUIElements({
          objectIds: [slider],
          values: [1],
        });
        yield* Deferred.await(firstStarted);
        yield* session.updateUIElements({
          objectIds: [slider, other],
          values: [2, 9],
        });
        yield* session.updateUIElements({
          objectIds: [slider],
          values: [3],
        });

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Deferred.await(secondStarted);

        yield* session.updateUIElements({ objectIds: [], values: [] });
        yield* session.updateUIElements({
          objectIds: [slider, other],
          values: [4],
        });

        const commands = marimoApiCommands(
          yield* Ref.get(ctx.sentCommands),
        ).filter((command) => command.params.method === "update-ui-element");
        expect(commands).toHaveLength(2);
        expect(commands[1]).toMatchObject({
          params: {
            method: "update-ui-element",
            params: {
              notebookUri: NOTEBOOK_A,
              inner: {
                objectIds: [slider, other],
                values: [3, 9],
              },
            },
          },
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "merges model state and keeps custom messages in order",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const finalStarted = yield* Deferred.make<void>();
      const modelA = widgetModelId("model-a");
      const modelB = widgetModelId("model-b");
      const ctx = yield* withTestContext(
        Effect.fn(function* (command) {
          if (
            command.command === "marimo.api" &&
            command.params.method === "update-ui-element"
          ) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
          if (
            command.command === "marimo.api" &&
            command.params.method === "set-model-value" &&
            command.params.params.inner.message.method === "update" &&
            command.params.params.inner.message.state.after === 3
          ) {
            yield* Deferred.succeed(finalStarted, undefined);
          }
        }),
      );

      yield* Effect.gen(function* () {
        const sessions = yield* RuntimeSessions;
        const session = yield* sessions.getOrCreate(NOTEBOOK_A);

        yield* session.updateUIElements({
          objectIds: [uiElementId("slider")],
          values: [1],
        });
        yield* Deferred.await(firstStarted);

        yield* session.updateModel({
          modelId: modelA,
          message: {
            method: "update",
            state: { value: 1, keep: true },
            bufferPaths: [
              ["value", "data"],
              ["keep", "data"],
            ],
          },
          buffers: [base64String("old-value"), base64String("keep")],
          token: "first",
        });
        yield* session.updateModel({
          modelId: modelB,
          message: {
            method: "update",
            state: { other: 1 },
            bufferPaths: [],
          },
          buffers: [],
        });
        yield* session.updateModel({
          modelId: modelA,
          message: {
            method: "update",
            state: { value: 2 },
            bufferPaths: [["value", "data"]],
          },
          buffers: [base64String("new-value")],
          token: "latest",
        });

        const custom = yield* session
          .updateModel({
            modelId: modelA,
            message: { method: "custom", content: { event: "click" } },
            buffers: [],
          })
          .pipe(Effect.fork);
        yield* TestClock.adjust("1 millis");

        yield* session.updateModel({
          modelId: modelA,
          message: {
            method: "update",
            state: { after: 3 },
            bufferPaths: [],
          },
          buffers: [],
        });

        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(custom);
        yield* Deferred.await(finalStarted);

        const modelRequests = marimoApiCommands(
          yield* Ref.get(ctx.sentCommands),
        ).flatMap((command) =>
          command.params.method === "set-model-value"
            ? [command.params.params.inner]
            : [],
        );
        expect(modelRequests).toHaveLength(4);
        expect(modelRequests).toMatchInlineSnapshot(`
          [
            {
              "buffers": [
                "keep",
                "new-value",
              ],
              "message": {
                "bufferPaths": [
                  [
                    "keep",
                    "data",
                  ],
                  [
                    "value",
                    "data",
                  ],
                ],
                "method": "update",
                "state": {
                  "keep": true,
                  "value": 2,
                },
              },
              "modelId": "model-a",
              "token": "latest",
            },
            {
              "buffers": [],
              "message": {
                "bufferPaths": [],
                "method": "update",
                "state": {
                  "other": 1,
                },
              },
              "modelId": "model-b",
            },
            {
              "buffers": [],
              "message": {
                "content": {
                  "event": "click",
                },
                "method": "custom",
              },
              "modelId": "model-a",
            },
            {
              "buffers": [],
              "message": {
                "bufferPaths": [],
                "method": "update",
                "state": {
                  "after": 3,
                },
              },
              "modelId": "model-a",
            },
          ]
        `);

        yield* session.invokeFunction({
          functionCallId: requestId("call"),
          namespace: "widget",
          functionName: "run",
          args: { value: 1 },
        });
        expect(
          marimoApiCommands(yield* Ref.get(ctx.sentCommands)).at(-1),
        ).toMatchObject({
          params: {
            method: "invoke-function",
            params: {
              notebookUri: NOTEBOOK_A,
              inner: {
                functionCallId: "call",
                namespace: "widget",
                functionName: "run",
                args: { value: 1 },
              },
            },
          },
        });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "sends ordinary commands in order while interrupt bypasses the queue",
    Effect.fn(function* () {
      const executionStarted = yield* Deferred.make<void>();
      const releaseExecution = yield* Deferred.make<void>();
      const ctx = yield* withTestContext(
        Effect.fn(function* (command) {
          if (
            command.command === "marimo.api" &&
            command.params.method === "execute-cells"
          ) {
            yield* Deferred.succeed(executionStarted, undefined);
            yield* Deferred.await(releaseExecution);
          }
        }),
      );

      yield* Effect.gen(function* () {
        const session = yield* (yield* RuntimeSessions).getOrCreate(NOTEBOOK_A);
        const execution = yield* session
          .executeCells(
            { cellIds: [cellId("cell-1")], codes: ["value = 1"] },
            "/usr/bin/python",
          )
          .pipe(Effect.fork);
        yield* Deferred.await(executionStarted);

        const deletion = yield* session
          .deleteCell({ cellId: cellId("cell-2") })
          .pipe(Effect.fork);
        yield* TestClock.adjust("1 millis");

        yield* session.interrupt();
        assert.deepStrictEqual(apiMethods(yield* Ref.get(ctx.sentCommands)), [
          "execute-cells",
          "interrupt",
        ]);

        yield* Deferred.succeed(releaseExecution, undefined);
        yield* Fiber.join(execution);
        yield* Fiber.join(deletion);
        yield* session.sendStdin({ text: "answer" });

        expect(marimoApiCommands(yield* Ref.get(ctx.sentCommands)))
          .toMatchInlineSnapshot(`
          [
            {
              "command": "marimo.api",
              "params": {
                "method": "execute-cells",
                "params": {
                  "executable": "/usr/bin/python",
                  "inner": {
                    "cellIds": [
                      "cell-1",
                    ],
                    "codes": [
                      "value = 1",
                    ],
                  },
                  "notebookUri": "notebook-a",
                },
              },
            },
            {
              "command": "marimo.api",
              "params": {
                "method": "interrupt",
                "params": {
                  "inner": {},
                  "notebookUri": "notebook-a",
                },
              },
            },
            {
              "command": "marimo.api",
              "params": {
                "method": "delete-cell",
                "params": {
                  "inner": {
                    "cellId": "cell-2",
                  },
                  "notebookUri": "notebook-a",
                },
              },
            },
            {
              "command": "marimo.api",
              "params": {
                "method": "send-stdin",
                "params": {
                  "inner": {
                    "text": "answer",
                  },
                  "notebookUri": "notebook-a",
                },
              },
            },
          ]
        `);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "close invalidates queued work and the old session handle",
    Effect.fn(function* () {
      const executionStarted = yield* Deferred.make<void>();
      const ctx = yield* withTestContext(
        Effect.fn(function* (command) {
          if (
            command.command === "marimo.api" &&
            command.params.method === "execute-cells"
          ) {
            yield* Deferred.succeed(executionStarted, undefined);
            yield* Effect.never;
          }
        }),
      );

      yield* Effect.gen(function* () {
        const sessions = yield* RuntimeSessions;
        const session = yield* sessions.getOrCreate(NOTEBOOK_A);
        const execution = yield* session
          .executeCells(
            { cellIds: [cellId("cell-1")], codes: ["value = 1"] },
            "/usr/bin/python",
          )
          .pipe(Effect.either, Effect.fork);
        yield* Deferred.await(executionStarted);
        const deletion = yield* session
          .deleteCell({ cellId: cellId("cell-2") })
          .pipe(Effect.either, Effect.fork);
        yield* TestClock.adjust("1 millis");

        yield* session.close();

        for (const result of [
          yield* Fiber.join(execution),
          yield* Fiber.join(deletion),
          yield* session.interrupt().pipe(Effect.either),
        ]) {
          assert(Either.isLeft(result));
          assert(result.left instanceof RuntimeCommandQueueClosedError);
        }
        assert.deepStrictEqual(apiMethods(yield* Ref.get(ctx.sentCommands)), [
          "execute-cells",
          "close-session",
        ]);

        const replacement = yield* sessions.getOrCreate(NOTEBOOK_A);
        expect(replacement).not.toBe(session);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "closes a session stream and creates a fresh session when reopened",
    Effect.fn(function* () {
      const ctx = yield* withTestContext();

      yield* Effect.gen(function* () {
        const sessions = yield* RuntimeSessions;
        const first = yield* sessions.getOrCreate(NOTEBOOK_A);
        const firstOperations = yield* first
          .operations()
          .pipe(Stream.runCollect, Effect.fork);
        yield* TestClock.adjust("1 millis");

        yield* first.shutdown();
        assert(Chunk.isEmpty(yield* Fiber.join(firstOperations)));

        const reopened = yield* sessions.getOrCreate(NOTEBOOK_A);
        expect(reopened).not.toBe(first);
        const nextOperation = yield* reopened
          .operations()
          .pipe(Stream.runHead, Effect.fork);
        yield* TestClock.adjust("1 millis");

        // A stale handle cannot shut down the replacement session.
        yield* first.shutdown();
        yield* PubSub.publish(ctx.source, completedRun(NOTEBOOK_A, "new"));

        const received = yield* Fiber.join(nextOperation);
        assert(Option.isSome(received));
        expect(received.value).toMatchObject({ run_id: "new" });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.scoped(
    "keeps the shared operation stream available for unopened sessions",
    Effect.fn(function* () {
      const ctx = yield* withTestContext();

      yield* Effect.gen(function* () {
        const sessions = yield* RuntimeSessions;
        const operation = yield* sessions
          .operations()
          .pipe(Stream.runHead, Effect.fork);
        yield* TestClock.adjust("1 millis");

        yield* PubSub.publish(ctx.source, completedRun(NOTEBOOK_B, "run"));

        const received = yield* Fiber.join(operation);
        assert(Option.isSome(received));
        expect(received.value).toEqual(completedRun(NOTEBOOK_B, "run"));
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
