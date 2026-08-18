import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Ref,
  ScopedCache,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import { NotebookSession } from "../notebook/NotebookSession.ts";
import type { MarimoConfig } from "../types.ts";

const cacheKey = "configuration" as const;

/** Configuration state for one open notebook document session. */
export class NotebookConfiguration extends Context.Service<NotebookConfiguration>()(
  "NotebookConfiguration",
  {
    make: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const session = yield* NotebookSession;
      const current = yield* SubscriptionRef.make(Option.none<MarimoConfig>());
      const generation = yield* Ref.make(0);
      const mutations = Semaphore.makeUnsafe(1);

      const fetchConfiguration = Effect.gen(function* () {
        yield* Effect.logTrace("Fetching configuration from LSP").pipe(
          Effect.annotateLogs({ notebookUri: session.notebookId }),
        );
        const result = yield* marimo.getConfiguration({
          notebookUri: session.notebookId,
          inner: {},
        });
        yield* Effect.logTrace("Configuration fetched").pipe(
          Effect.annotateLogs({ notebookUri: session.notebookId }),
        );
        return result.config;
      });

      const cache = yield* ScopedCache.makeWith({
        capacity: 1,
        lookup: () => fetchConfiguration,
        timeToLive: (exit) =>
          Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
      });

      const get = Effect.gen(function* () {
        const expectedGeneration = yield* Ref.get(generation);
        const config = yield* ScopedCache.get(cache, cacheKey);
        if (
          expectedGeneration % 2 === 0 &&
          (yield* Ref.get(generation)) === expectedGeneration
        ) {
          yield* SubscriptionRef.set(current, Option.some(config));
        }
        return config;
      });

      const mutate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        mutations.withPermit(
          Ref.update(generation, (value) => value + 1).pipe(
            Effect.andThen(effect),
            Effect.ensuring(Ref.update(generation, (value) => value + 1)),
          ),
        );

      const update = (partialConfig: Record<string, unknown>) =>
        mutate(
          Effect.gen(function* () {
            yield* Effect.logTrace("Updating configuration").pipe(
              Effect.annotateLogs({
                notebookUri: session.notebookId,
                config: partialConfig,
              }),
            );
            const config = yield* marimo.updateConfiguration({
              notebookUri: session.notebookId,
              inner: { config: partialConfig },
            });
            yield* ScopedCache.set(cache, cacheKey, config);
            yield* SubscriptionRef.set(current, Option.some(config));
            yield* Effect.logTrace("Configuration updated successfully").pipe(
              Effect.annotateLogs({ notebookUri: session.notebookId }),
            );
            return config;
          }),
        );

      const invalidate = mutate(
        ScopedCache.invalidate(cache, cacheKey).pipe(
          Effect.andThen(SubscriptionRef.set(current, Option.none())),
          Effect.tap(() =>
            Effect.logTrace("Cleared configuration cache").pipe(
              Effect.annotateLogs({ notebookUri: session.notebookId }),
            ),
          ),
        ),
      );

      const load = get.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to load notebook configuration").pipe(
            Effect.annotateLogs({
              notebookUri: session.notebookId,
              cause,
            }),
          ),
        ),
      );

      return {
        get,
        update,
        invalidate,
        changes: Stream.merge(
          SubscriptionRef.changes(current),
          Stream.fromEffect(load).pipe(Stream.drain),
        ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
