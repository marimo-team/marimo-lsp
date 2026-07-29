import { assert, describe, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Either,
  Fiber,
  Option,
  Ref,
  TestClock,
} from "effect";

import {
  makeRuntimeCommandQueue,
  RuntimeCommandQueueClosedError,
} from "../RuntimeCommandQueue.ts";

type Command =
  | {
      readonly _tag: "State";
      readonly kind: "ui" | "model";
      readonly values: ReadonlyMap<string, number>;
    }
  | { readonly _tag: "Event"; readonly name: string };

const state = (
  kind: "ui" | "model",
  ...entries: ReadonlyArray<readonly [string, number]>
): Command => ({ _tag: "State", kind, values: new Map(entries) });

const event = (name: string): Command => ({ _tag: "Event", name });

const mergeState = (older: Command, newer: Command): Command => {
  assert(older._tag === "State");
  assert(newer._tag === "State");
  return {
    ...newer,
    values: new Map([...older.values, ...newer.values]),
  };
};

const summarize = (command: Command): string => {
  if (command._tag === "Event") return command.name;
  const values = [...command.values]
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return `${command.kind}(${values})`;
};

describe("RuntimeCommandQueue", () => {
  it.scoped(
    "keeps the latest adjacent replaceable state while send is in flight",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const sent = yield* Ref.make<ReadonlyArray<Command>>([]);

      const queue = yield* makeRuntimeCommandQueue(
        Effect.fn(function* (command: Command) {
          yield* Ref.update(sent, (commands) => [...commands, command]);
          if (summarize(command) === "ui(slider=1)") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          } else {
            yield* Deferred.succeed(secondStarted, undefined);
          }
        }),
      );

      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 1]),
        merge: mergeState,
      });
      yield* Deferred.await(firstStarted);
      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 2], ["other", 9]),
        merge: mergeState,
      });
      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 3]),
        merge: mergeState,
      });

      assert.deepStrictEqual((yield* Ref.get(sent)).map(summarize), [
        "ui(slider=1)",
      ]);

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondStarted);

      assert.deepStrictEqual((yield* Ref.get(sent)).map(summarize), [
        "ui(slider=1)",
        "ui(slider=3,other=9)",
      ]);
    }),
  );

  it.scoped(
    "keeps commands and different kinds of state in order",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const sent = yield* Ref.make<ReadonlyArray<Command>>([]);

      const queue = yield* makeRuntimeCommandQueue(
        Effect.fn(function* (command: Command) {
          yield* Ref.update(sent, (commands) => [...commands, command]);
          if (summarize(command) === "ui(slider=1)") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          }
        }),
      );

      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 1]),
        merge: mergeState,
      });
      yield* Deferred.await(firstStarted);
      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 2]),
        merge: mergeState,
      });
      const ordered = yield* queue.send(event("custom")).pipe(Effect.fork);
      yield* TestClock.adjust("1 millis");
      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 3]),
        merge: mergeState,
      });
      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 4]),
        merge: mergeState,
      });
      yield* queue.enqueueState({
        kind: "model",
        command: state("model", ["value", 1]),
        merge: mergeState,
      });
      yield* queue.enqueueState({
        kind: "model",
        command: state("model", ["value", 2]),
        merge: mergeState,
      });

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Fiber.join(ordered);

      assert.deepStrictEqual((yield* Ref.get(sent)).map(summarize), [
        "ui(slider=1)",
        "ui(slider=2)",
        "custom",
        "ui(slider=4)",
        "model(value=2)",
      ]);
    }),
  );

  it.scoped(
    "reports a send failure, then sends the next command without retrying",
    Effect.fn(function* () {
      const failedStarted = yield* Deferred.make<void>();
      const releaseFailure = yield* Deferred.make<void>();
      const nextStarted = yield* Deferred.make<void>();
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);

      const queue = yield* makeRuntimeCommandQueue(
        Effect.fn(function* (command: Command) {
          const name = summarize(command);
          yield* Ref.update(attempts, (names) => [...names, name]);
          if (name === "fails") {
            yield* Deferred.succeed(failedStarted, undefined);
            yield* Deferred.await(releaseFailure);
            return yield* Effect.fail("not sent");
          }
          return yield* Deferred.succeed(nextStarted, undefined);
        }),
      );

      const failed = yield* queue
        .send(event("fails"))
        .pipe(Effect.either, Effect.fork);
      yield* Deferred.await(failedStarted);
      const next = yield* queue.send(event("next")).pipe(Effect.fork);

      assert(Option.isNone(yield* Fiber.poll(failed)));
      assert(Option.isNone(yield* Fiber.poll(next)));

      yield* Deferred.succeed(releaseFailure, undefined);
      assert.deepStrictEqual(
        yield* Fiber.join(failed),
        Either.left("not sent"),
      );
      yield* Deferred.await(nextStarted);
      yield* Fiber.join(next);
      assert.deepStrictEqual(yield* Ref.get(attempts), ["fails", "next"]);
    }),
  );

  it.scoped(
    "continues after a replaceable send fails without retrying it",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFailure = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const attempts = yield* Ref.make<ReadonlyArray<string>>([]);

      const queue = yield* makeRuntimeCommandQueue(
        Effect.fn(function* (command: Command) {
          const summary = summarize(command);
          yield* Ref.update(attempts, (commands) => [...commands, summary]);
          if (summary === "ui(slider=1)") {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFailure);
            return yield* Effect.fail("not sent");
          }
          return yield* Deferred.succeed(secondStarted, undefined);
        }),
      );

      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 1]),
        merge: mergeState,
      });
      yield* Deferred.await(firstStarted);
      yield* queue.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 2]),
        merge: mergeState,
      });

      yield* Deferred.succeed(releaseFailure, undefined);
      yield* Deferred.await(secondStarted);

      assert.deepStrictEqual(yield* Ref.get(attempts), [
        "ui(slider=1)",
        "ui(slider=2)",
      ]);
    }),
  );

  it.scoped(
    "lets separate session queues send independently",
    Effect.fn(function* () {
      const releaseA = yield* Deferred.make<void>();
      const startedA = yield* Deferred.make<void>();
      const startedB = yield* Deferred.make<void>();

      const queueA = yield* makeRuntimeCommandQueue(
        Effect.fn(function* (_command: Command) {
          yield* Deferred.succeed(startedA, undefined);
          yield* Deferred.await(releaseA);
        }),
      );
      const queueB = yield* makeRuntimeCommandQueue((_command: Command) =>
        Deferred.succeed(startedB, undefined),
      );

      yield* queueA.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 1]),
        merge: mergeState,
      });
      yield* Deferred.await(startedA);
      yield* queueB.enqueueState({
        kind: "ui",
        command: state("ui", ["slider", 2]),
        merge: mergeState,
      });

      yield* Deferred.await(startedB);
      yield* Deferred.succeed(releaseA, undefined);
    }),
  );

  it.scoped(
    "invalidates in-flight and pending work when closed",
    Effect.fn(function* () {
      const started = yield* Deferred.make<void>();
      const queue = yield* makeRuntimeCommandQueue(
        Effect.fn(function* (_command: Command) {
          yield* Deferred.succeed(started, undefined);
          yield* Effect.never;
        }),
      );

      const inFlight = yield* queue
        .send(event("in-flight"))
        .pipe(Effect.either, Effect.fork);
      yield* Deferred.await(started);
      const pending = yield* queue
        .send(event("pending"))
        .pipe(Effect.either, Effect.fork);
      yield* TestClock.adjust("1 millis");

      yield* queue.close();

      for (const result of [
        yield* Fiber.join(inFlight),
        yield* Fiber.join(pending),
        yield* queue.send(event("late")).pipe(Effect.either),
      ]) {
        assert(Either.isLeft(result));
        assert(result.left instanceof RuntimeCommandQueueClosedError);
      }

      const lateState = yield* queue
        .enqueueState({
          kind: "ui",
          command: state("ui", ["slider", 1]),
          merge: mergeState,
        })
        .pipe(Effect.either);
      assert(Either.isLeft(lateState));
      assert(lateState.left instanceof RuntimeCommandQueueClosedError);
    }),
  );
});
