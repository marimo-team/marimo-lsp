import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, Logger, PubSub, Queue } from "effect";

import { commandId } from "../../commands.ts";
import { newMarimoNotebookCommand } from "../../commands/newMarimoNotebook.ts";
import { openTutorialCommand } from "../../commands/openTutorial.ts";
import { restartKernelCommand } from "../../commands/restartKernel.ts";
import { runStaleCommand } from "../../commands/runStale.ts";
import { withCommandContext } from "../VsCode.ts";

describe("command error context", () => {
  it.effect("logs failures with their command span", () => {
    const logs: Array<Record<string, unknown>> = [];
    const wireId = commandId(runStaleCommand);
    const logger = Logger.make(({ annotations }) => {
      logs.push(Object.fromEntries(annotations));
    });

    return Effect.fail(new Error("invalid command argument")).pipe(
      withCommandContext(runStaleCommand),
      Effect.exit,
      Effect.provide(
        Logger.replace(
          Logger.defaultLogger,
          Logger.withSpanAnnotations(logger),
        ),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          expect(logs).toHaveLength(1);
          expect(logs[0]).toMatchObject({
            "command.id": wireId,
            "effect.spanName": "command",
          });
        }),
      ),
    );
  });
});

describe("Commands pubsub", () => {
  it.effect(
    "should receive command events through subscription",
    Effect.fn(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const commandPubSub =
            yield* PubSub.unbounded<Either.Either<string, string>>();

          // Subscribe to the pubsub
          const subscription = yield* PubSub.subscribe(commandPubSub);

          // Publish events
          yield* PubSub.publish(
            commandPubSub,
            Either.right(commandId(newMarimoNotebookCommand)),
          );
          yield* PubSub.publish(
            commandPubSub,
            Either.right(commandId(openTutorialCommand)),
          );
          yield* PubSub.publish(
            commandPubSub,
            Either.left(commandId(restartKernelCommand)),
          );

          // Take 3 events from the subscription
          const event1 = yield* Queue.take(subscription);
          const event2 = yield* Queue.take(subscription);
          const event3 = yield* Queue.take(subscription);

          return [event1, event2, event3];
        }),
      );

      expect(result).toHaveLength(3);

      // Verify we got the expected events
      expect(Either.isRight(result[0])).toBe(true);
      expect(Either.isRight(result[1])).toBe(true);
      expect(Either.isLeft(result[2])).toBe(true);

      if (Either.isRight(result[0])) {
        expect(result[0].right).toBe(commandId(newMarimoNotebookCommand));
      }
      if (Either.isRight(result[1])) {
        expect(result[1].right).toBe(commandId(openTutorialCommand));
      }
      if (Either.isLeft(result[2])) {
        expect(result[2].left).toBe(commandId(restartKernelCommand));
      }
    }),
  );

  it.effect(
    "should support multiple subscribers",
    Effect.fn(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const commandPubSub =
            yield* PubSub.unbounded<Either.Either<string, string>>();

          // Create two subscribers
          const sub1 = yield* PubSub.subscribe(commandPubSub);
          const sub2 = yield* PubSub.subscribe(commandPubSub);

          // Publish events
          yield* PubSub.publish(
            commandPubSub,
            Either.right(commandId(newMarimoNotebookCommand)),
          );
          yield* PubSub.publish(
            commandPubSub,
            Either.right(commandId(openTutorialCommand)),
          );

          // Both subscribers should receive both events
          const events1 = [yield* Queue.take(sub1), yield* Queue.take(sub1)];
          const events2 = [yield* Queue.take(sub2), yield* Queue.take(sub2)];

          return { events1, events2 };
        }),
      );

      expect(result.events1).toHaveLength(2);
      expect(result.events2).toHaveLength(2);

      // Both should have received the same events
      expect(result.events1[0]).toEqual(result.events2[0]);
      expect(result.events1[1]).toEqual(result.events2[1]);
    }),
  );
});
