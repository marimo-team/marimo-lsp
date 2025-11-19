import { describe, expect, it } from "@effect/vitest";
import { Effect, Either, PubSub, Queue } from "effect";

describe("Commands pubsub", () => {
  it.effect(
    "should receive command events through subscription",
    Effect.fnUntraced(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const commandPubSub =
            yield* PubSub.unbounded<Either.Either<string, string>>();

          // Subscribe to the pubsub
          const subscription = yield* PubSub.subscribe(commandPubSub);

          // Publish events
          yield* PubSub.publish(
            commandPubSub,
            Either.right("marimo.newMarimoNotebook"),
          );
          yield* PubSub.publish(
            commandPubSub,
            Either.right("marimo.openTutorial"),
          );
          yield* PubSub.publish(
            commandPubSub,
            Either.left("marimo.restartKernel"),
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
        expect(result[0].right).toBe("marimo.newMarimoNotebook");
      }
      if (Either.isRight(result[1])) {
        expect(result[1].right).toBe("marimo.openTutorial");
      }
      if (Either.isLeft(result[2])) {
        expect(result[2].left).toBe("marimo.restartKernel");
      }
    }),
  );

  it.effect(
    "should support multiple subscribers",
    Effect.fnUntraced(function* () {
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
            Either.right("marimo.newMarimoNotebook"),
          );
          yield* PubSub.publish(
            commandPubSub,
            Either.right("marimo.openTutorial"),
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
