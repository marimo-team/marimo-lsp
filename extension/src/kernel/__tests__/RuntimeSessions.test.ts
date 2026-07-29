import { assert, describe, expect, it } from "@effect/vitest";
import {
  Chunk,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Ref,
  Stream,
  TestClock,
} from "effect";

import { notebookId } from "../../lib/__tests__/branded.ts";
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

const withTestContext = Effect.fn(function* () {
  const source = yield* PubSub.unbounded<MarimoOperation>();
  const rawSubscriptions = yield* Ref.make(0);

  const client = Layer.succeed(
    LanguageClient,
    LanguageClient.make({
      channel: { name: "marimo-lsp", show() {} },
      restart: () => Effect.void,
      executeCommand: (_command: MarimoCommand) => Effect.void,
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
    layer: RuntimeSessions.Default.pipe(Layer.provide(client)),
  };
});

const runIds = (
  operations: Chunk.Chunk<Notification>,
): ReadonlyArray<string | null | undefined> =>
  Chunk.toReadonlyArray(operations)
    .filter((operation) => operation.op === "completed-run")
    .map((operation) => operation.run_id);

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
