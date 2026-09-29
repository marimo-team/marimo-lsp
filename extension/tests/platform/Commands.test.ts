import * as Vitest from "@effect/vitest";
import { Data, Effect, Logger, PubSub, References, Result } from "effect";

import { commandId } from "../../src/commands.ts";
import newMarimoNotebook from "../../src/commands/newMarimoNotebook.ts";
import openTutorial from "../../src/commands/openTutorial.ts";
import restartKernel from "../../src/commands/restartKernel.ts";
import runStale from "../../src/commands/runStale.ts";
import { withCommandContext } from "../../src/platform/Commands.ts";

class InvalidCommandArgument extends Data.TaggedError(
  "InvalidCommandArgument",
)<{ readonly message: string }> {}

Vitest.describe("command error context", () => {
  Vitest.it.effect("logs failures with their command ID", () => {
    const logs: Array<Record<string, unknown>> = [];
    const wireId = commandId(runStale.command);
    const logger = Logger.make(({ fiber }) => {
      logs.push({ ...fiber.getRef(References.CurrentLogAnnotations) });
    });

    return Effect.fail(
      new InvalidCommandArgument({ message: "invalid command argument" }),
    ).pipe(
      withCommandContext(runStale.command),
      Effect.exit,
      Effect.provide(Logger.layer([logger])),
      Effect.tap(() =>
        Effect.sync(() => {
          Vitest.expect(logs).toHaveLength(1);
          Vitest.expect(logs[0]).toMatchObject({
            "command.id": wireId,
          });
        }),
      ),
    );
  });
});

Vitest.describe("Commands pubsub", () => {
  Vitest.it.effect(
    "should receive command events through subscription",
    Effect.fn(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const commandPubSub =
            yield* PubSub.unbounded<Result.Result<string, string>>();

          // Subscribe to the pubsub
          const subscription = yield* PubSub.subscribe(commandPubSub);

          // Publish events
          yield* PubSub.publish(
            commandPubSub,
            Result.succeed(commandId(newMarimoNotebook.command)),
          );
          yield* PubSub.publish(
            commandPubSub,
            Result.succeed(commandId(openTutorial.command)),
          );
          yield* PubSub.publish(
            commandPubSub,
            Result.fail(commandId(restartKernel.command)),
          );

          // Take 3 events from the subscription
          const event1 = yield* PubSub.take(subscription);
          const event2 = yield* PubSub.take(subscription);
          const event3 = yield* PubSub.take(subscription);

          return [event1, event2, event3];
        }),
      );

      Vitest.expect(result).toHaveLength(3);

      // Verify we got the expected events
      Vitest.expect(Result.isSuccess(result[0])).toBe(true);
      Vitest.expect(Result.isSuccess(result[1])).toBe(true);
      Vitest.expect(Result.isFailure(result[2])).toBe(true);

      if (Result.isSuccess(result[0])) {
        Vitest.expect(result[0].success).toBe(
          commandId(newMarimoNotebook.command),
        );
      }
      if (Result.isSuccess(result[1])) {
        Vitest.expect(result[1].success).toBe(commandId(openTutorial.command));
      }
      if (Result.isFailure(result[2])) {
        Vitest.expect(result[2].failure).toBe(commandId(restartKernel.command));
      }
    }),
  );

  Vitest.it.effect(
    "should support multiple subscribers",
    Effect.fn(function* () {
      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const commandPubSub =
            yield* PubSub.unbounded<Result.Result<string, string>>();

          // Create two subscribers
          const sub1 = yield* PubSub.subscribe(commandPubSub);
          const sub2 = yield* PubSub.subscribe(commandPubSub);

          // Publish events
          yield* PubSub.publish(
            commandPubSub,
            Result.succeed(commandId(newMarimoNotebook.command)),
          );
          yield* PubSub.publish(
            commandPubSub,
            Result.succeed(commandId(openTutorial.command)),
          );

          // Both subscribers should receive both events
          const events1 = [yield* PubSub.take(sub1), yield* PubSub.take(sub1)];
          const events2 = [yield* PubSub.take(sub2), yield* PubSub.take(sub2)];

          return { events1, events2 };
        }),
      );

      Vitest.expect(result.events1).toHaveLength(2);
      Vitest.expect(result.events2).toHaveLength(2);

      // Both should have received the same events
      Vitest.expect(result.events1[0]).toEqual(result.events2[0]);
      Vitest.expect(result.events1[1]).toEqual(result.events2[1]);
    }),
  );
});
