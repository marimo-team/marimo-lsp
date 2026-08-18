import {
  Cache,
  Context,
  Duration,
  Effect,
  Exit,
  HashMap,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import {
  type NotebookDocumentSession,
  NotebookDocumentSessions,
} from "../notebook/NotebookDocumentSessions.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import type { MarimoConfig } from "../types.ts";

type ConfigurationCacheKey = readonly [
  notebookId: NotebookId,
  sessionId: NotebookDocumentSession["id"],
];

const keyFor = (session: NotebookDocumentSession): ConfigurationCacheKey => [
  session.notebookId,
  session.id,
];

/**
 * Manages marimo configuration state across all notebooks.
 *
 * Caches configuration lookups by document session. A SubscriptionRef keeps a
 * reactive projection of resolved values for stream consumers.
 */
export class MarimoConfigurationService extends Context.Service<MarimoConfigurationService>()(
  "MarimoConfigurationService",
  {
    make: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const editorRegistry = yield* NotebookEditorRegistry;
      const documentSessions = yield* NotebookDocumentSessions;

      const fetchConfiguration = (notebookUri: NotebookId) =>
        Effect.gen(function* () {
          yield* Effect.logTrace("Fetching configuration from LSP").pipe(
            Effect.annotateLogs({ notebookUri }),
          );
          const result = yield* marimo.getConfiguration({
            notebookUri,
            inner: {},
          });
          yield* Effect.logTrace("Configuration fetched").pipe(
            Effect.annotateLogs({ notebookUri }),
          );
          return result.config;
        });

      const configurationCache = yield* Cache.makeWith(
        ([notebookUri]: ConfigurationCacheKey) =>
          // Cache starts its lookup fiber before publishing the entry. Yield
          // once so invalidation can always observe an in-flight request.
          Effect.yieldNow.pipe(Effect.andThen(fetchConfiguration(notebookUri))),
        {
          capacity: Number.POSITIVE_INFINITY,
          // Preserve the previous retry behavior for failed LSP requests.
          timeToLive: (exit) =>
            Exit.isSuccess(exit) ? Duration.infinity : Duration.zero,
        },
      );
      const configProjection = yield* SubscriptionRef.make(
        HashMap.empty<ConfigurationCacheKey, MarimoConfig>(),
      );
      const projectCurrent = (key: ConfigurationCacheKey) =>
        Effect.gen(function* () {
          const current = yield* Cache.getSuccess(configurationCache, key);
          yield* SubscriptionRef.update(configProjection, (projection) =>
            Option.match(current, {
              onNone: () => HashMap.remove(projection, key),
              onSome: (config) => HashMap.set(projection, key, config),
            }),
          );
        });
      const clearCache = (
        notebookUri: NotebookId,
        expectedSession?: NotebookDocumentSession,
      ) =>
        Effect.gen(function* () {
          const keys: ReadonlyArray<ConfigurationCacheKey> = expectedSession
            ? [keyFor(expectedSession)]
            : Array.from(yield* Cache.keys(configurationCache)).filter(
                ([cachedNotebookId]) => cachedNotebookId === notebookUri,
              );
          for (const key of keys) {
            yield* Cache.invalidate(configurationCache, key);
          }
          yield* SubscriptionRef.update(configProjection, (projection) => {
            let next = projection;
            for (const key of keys) {
              next = HashMap.remove(next, key);
            }
            return next;
          });
          yield* Effect.logTrace("Cleared configuration cache").pipe(
            Effect.annotateLogs({ notebookUri }),
          );
        });

      yield* Effect.forkScoped(
        documentSessions.changes.pipe(
          Stream.runForEach((change) =>
            change._tag === "Ended"
              ? clearCache(change.session.notebookId, change.session)
              : Effect.void,
          ),
        ),
      );

      /**
       * Stream of configuration changes for the active notebook.
       *
       * Emits the current value on subscription, then all subsequent changes.
       * Filters consecutive duplicates via Stream.changes.
       */
      const streamActiveConfigChanges = () =>
        Stream.zipLatest(
          SubscriptionRef.changes(configProjection),
          editorRegistry.streamActiveNotebookChanges,
        ).pipe(
          Stream.map(([projection, activeNotebookUri]) => {
            if (Option.isNone(activeNotebookUri)) {
              return Option.none<MarimoConfig>();
            }
            const currentSession = documentSessions.current(
              activeNotebookUri.value,
            );
            return currentSession === undefined
              ? Option.none<MarimoConfig>()
              : HashMap.get(projection, keyFor(currentSession));
          }),
          Stream.changes,
        );

      return {
        /**
         * Get the configuration for a notebook
         */
        getConfig(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const session = documentSessions.current(notebookUri);
            if (session === undefined) {
              return yield* fetchConfiguration(notebookUri);
            }

            const key = keyFor(session);
            const config = yield* Cache.get(configurationCache, key);
            yield* projectCurrent(key);
            return config;
          });
        },

        /**
         * Update the configuration for a notebook
         */
        updateConfig(
          notebookUri: NotebookId,
          partialConfig: Record<string, unknown>,
        ) {
          return Effect.gen(function* () {
            const session = documentSessions.current(notebookUri);
            yield* Effect.logTrace("Updating configuration").pipe(
              Effect.annotateLogs({ notebookUri, config: partialConfig }),
            );

            // Send update to LSP server
            const result = yield* marimo.updateConfiguration({
              notebookUri,
              inner: {
                config: partialConfig,
              },
            });

            if (
              session !== undefined &&
              documentSessions.current(notebookUri) === session
            ) {
              const key = keyFor(session);
              yield* Cache.set(configurationCache, key, result);
              yield* projectCurrent(key);
            }

            yield* Effect.logTrace("Configuration updated successfully").pipe(
              Effect.annotateLogs({ notebookUri }),
            );

            return result;
          });
        },

        /**
         * Clear configuration for a notebook
         */
        clearNotebook: (notebookUri: NotebookId) => clearCache(notebookUri),

        /**
         * Stream of mapped configuration values for the active notebook.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamOf<R>(
          mapper: (config: MarimoConfig) => R,
        ): Stream.Stream<Option.Option<R>> {
          return streamActiveConfigChanges().pipe(
            Stream.map((config) => {
              return Option.map(config, mapper);
            }),
            Stream.changes,
          );
        },
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide(NotebookDocumentSessions.layer),
  );
}
