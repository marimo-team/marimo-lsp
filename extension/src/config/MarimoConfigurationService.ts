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
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { makeNotebookSessions } from "../notebook/NotebookSessions.ts";
import { VsCode } from "../platform/VsCode.ts";
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
      const code = yield* VsCode;
      const marimo = yield* MarimoClient;
      const editorRegistry = yield* NotebookEditorRegistry;

      // Track configurations: NotebookUri -> MarimoConfig
      const configRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, MarimoConfig>(),
      );
      const clearCache = (notebookUri: NotebookId) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.update(configRef, (map) =>
            HashMap.remove(map, notebookUri),
          );

          yield* Effect.logTrace("Cleared configuration cache").pipe(
            Effect.annotateLogs({ notebookUri }),
          );
        });

      const sessions = yield* makeNotebookSessions(code, clearCache);

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
            const session = yield* sessions.sessionFor(notebookUri);
            // First check if we have it cached
            const map = yield* SubscriptionRef.get(configRef);
            const cached = HashMap.get(map, notebookUri);

            if (Option.isSome(cached)) {
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
            const cacheIsCurrent = sessions.current(notebookUri) === session;
            if (cacheIsCurrent) {
              yield* SubscriptionRef.update(configRef, (map) =>
                HashMap.set(map, notebookUri, result.config),
              );
            }

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
            const session = yield* sessions.sessionFor(notebookUri);
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

            if (sessions.current(notebookUri) === session) {
              yield* SubscriptionRef.update(configRef, (map) =>
                HashMap.set(map, notebookUri, result),
              );
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
        clearNotebook: sessions.invalidate,

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
  static readonly layer = Layer.effect(this, this.make);
}
