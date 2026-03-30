import { Duration, Effect, PubSub, Stream } from "effect";

import { PythonExtension } from "./PythonExtension.ts";

/**
 * Broadcast channel for Python environment invalidation events.
 *
 * Publishers (env changes, package installs) call `invalidate(reason)`.
 * Consumers (ty language server) subscribe via `changes()` and restart.
 */
export class PythonEnvInvalidation extends Effect.Service<PythonEnvInvalidation>()(
  "PythonEnvInvalidation",
  {
    scoped: Effect.gen(function* () {
      const pyExt = yield* PythonExtension;
      const pubsub = yield* PubSub.unbounded<string>();

      // Forward Python extension env changes into the invalidation channel
      yield* Effect.forkScoped(
        pyExt.activeEnvironmentPathChanges().pipe(
          Stream.debounce(Duration.seconds(2)),
          Stream.runForEach(() => PubSub.publish(pubsub, "python-env-change")),
        ),
      );

      return {
        invalidate: (reason: string) => PubSub.publish(pubsub, reason),
        changes: () => Stream.fromPubSub(pubsub),
      };
    }),
  },
) {}
