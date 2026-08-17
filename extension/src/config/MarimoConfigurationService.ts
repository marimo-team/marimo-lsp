import {
  Context,
  Effect,
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

/**
 * Manages marimo configuration state across all notebooks.
 *
 * Tracks configuration for each notebook using SubscriptionRef for reactive
 * state management. Configurations are fetched from the LSP server, updated
 * both locally and remotely, and evicted when the notebook closes.
 */
export class MarimoConfigurationService extends Context.Service<MarimoConfigurationService>()(
  "MarimoConfigurationService",
  {
    make: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const editorRegistry = yield* NotebookEditorRegistry;
      const documentSessions = yield* NotebookDocumentSessions;

      // Track configurations: NotebookUri -> MarimoConfig
      const configRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, MarimoConfig>(),
      );
      const cacheOwners = new Map<NotebookId, NotebookDocumentSession>();
      const cacheGenerations = new Map<NotebookId, symbol>();
      const generationFor = (notebookUri: NotebookId) => {
        const existing = cacheGenerations.get(notebookUri);
        if (existing !== undefined) return existing;
        const generation = Symbol("configuration cache generation");
        cacheGenerations.set(notebookUri, generation);
        return generation;
      };
      const clearCache = (
        notebookUri: NotebookId,
        expectedOwner?: NotebookDocumentSession,
      ) =>
        SubscriptionRef.update(configRef, (map) => {
          if (
            expectedOwner !== undefined &&
            cacheOwners.get(notebookUri) !== expectedOwner
          ) {
            return map;
          }
          cacheOwners.delete(notebookUri);
          cacheGenerations.set(
            notebookUri,
            Symbol("configuration cache generation"),
          );
          return HashMap.remove(map, notebookUri);
        }).pipe(
          Effect.tap(() =>
            Effect.logTrace("Cleared configuration cache").pipe(
              Effect.annotateLogs({ notebookUri }),
            ),
          ),
        );

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
          SubscriptionRef.changes(configRef),
          editorRegistry.streamActiveNotebookChanges,
        ).pipe(
          Stream.map(([map, activeNotebookUri]) => {
            if (Option.isNone(activeNotebookUri)) {
              return Option.none<MarimoConfig>();
            }
            return HashMap.get(map, activeNotebookUri.value);
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
            const generation = generationFor(notebookUri);
            // First check if we have it cached
            const map = yield* SubscriptionRef.get(configRef);
            const cached = HashMap.get(map, notebookUri);

            if (
              session !== undefined &&
              cacheOwners.get(notebookUri) === session &&
              Option.isSome(cached)
            ) {
              return cached.value;
            }

            // Fetch from LSP server
            yield* Effect.logTrace("Fetching configuration from LSP").pipe(
              Effect.annotateLogs({ notebookUri }),
            );

            const result = yield* marimo.getConfiguration({
              notebookUri,
              inner: {},
            });

            // A close may have invalidated this request while it was in
            // flight. Return its result to the original caller, but never
            // repopulate a cache belonging to a newer notebook session.
            let cacheIsCurrent = false;
            yield* SubscriptionRef.update(configRef, (map) => {
              cacheIsCurrent =
                session !== undefined &&
                documentSessions.current(notebookUri) === session &&
                generationFor(notebookUri) === generation;
              if (!cacheIsCurrent || session === undefined) return map;
              cacheOwners.set(notebookUri, session);
              return HashMap.set(map, notebookUri, result.config);
            });

            yield* Effect.logTrace("Configuration fetched").pipe(
              Effect.annotateLogs({ notebookUri, cached: cacheIsCurrent }),
            );

            return result.config;
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
            const generation = generationFor(notebookUri);
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

            yield* SubscriptionRef.update(configRef, (map) => {
              if (
                session === undefined ||
                documentSessions.current(notebookUri) !== session ||
                generationFor(notebookUri) !== generation
              ) {
                return map;
              }
              cacheOwners.set(notebookUri, session);
              return HashMap.set(map, notebookUri, result);
            });

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
