import { assert, describe, expect, it } from "@effect/vitest";
import {
  Chunk,
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
  TestClock,
} from "effect";

import {
  base64String,
  notebookId,
  requestId,
  uiElementId,
  widgetModelId,
} from "../../lib/__tests__/branded.ts";
import { LanguageClient } from "../../lsp/LanguageClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { MarimoCommand, Notification } from "../../types.ts";
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

const marimoApiCommands = (
  commands: ReadonlyArray<MarimoCommand>,
): ReadonlyArray<MarimoApiCommand> =>
  commands.filter(
    (command): command is MarimoApiCommand => command.command === "marimo.api",
  );

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
