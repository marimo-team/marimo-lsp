import {
  Context,
  Duration,
  Effect,
  Layer,
  PubSub,
  Stream,
  SubscriptionRef,
} from "effect";

import * as PythonExtension from "./PythonExtension.ts";

/**
 * Broadcast channel for Python environment invalidation events.
 *
 * Publishers (env changes, package installs) call `invalidate(reason)`.
 * Consumers (ty language server) subscribe via `changes` and restart.
 */
export interface Interface {
  readonly invalidate: (reason: string) => Effect.Effect<boolean>;
  readonly changes: Stream.Stream<string>;
  readonly generation: Effect.Effect<number>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/PythonEnvInvalidation",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const pyExt = yield* PythonExtension.Service;
    const pubsub = yield* PubSub.unbounded<string>();
    const generation = yield* SubscriptionRef.make(0);

    // Forward Python extension env changes into the invalidation channel
    yield* Effect.forkScoped(
      pyExt.activeEnvironmentPathChanges.pipe(
        Stream.debounce(Duration.seconds(2)),
        Stream.runForEach(() => PubSub.publish(pubsub, "python-env-change")),
      ),
    );

    const invalidate = Effect.fn("PythonEnvInvalidation.invalidate")(function* (
      reason: string,
    ) {
      yield* SubscriptionRef.update(generation, (value) => value + 1);
      return yield* PubSub.publish(pubsub, reason);
    });
    const changes = Stream.fromPubSub(pubsub);

    return Service.of({
      invalidate,
      changes,
      generation: SubscriptionRef.get(generation),
    });
  }),
);
