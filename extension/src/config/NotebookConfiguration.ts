import {
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  ScopedCache,
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

      const get = ScopedCache.get(cache, cacheKey).pipe(
        Effect.tap((config) =>
          SubscriptionRef.set(current, Option.some(config)),
        ),
      );

      const update = (partialConfig: Record<string, unknown>) =>
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
        });

      const invalidate = ScopedCache.invalidate(cache, cacheKey).pipe(
        Effect.andThen(SubscriptionRef.set(current, Option.none())),
        Effect.tap(() =>
          Effect.logTrace("Cleared configuration cache").pipe(
            Effect.annotateLogs({ notebookUri: session.notebookId }),
          ),
        ),
      );

      return {
        get,
        update,
        invalidate,
        changes: SubscriptionRef.changes(current),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
