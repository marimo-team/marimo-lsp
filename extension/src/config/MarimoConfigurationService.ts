import { Effect, HashMap, Option, Stream, SubscriptionRef } from "effect";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import type { MarimoConfig } from "../types.ts";

/**
 * Manages marimo configuration state across all notebooks.
 *
 * Tracks configuration for each notebook using SubscriptionRef for reactive
 * state management. Configurations are fetched from the LSP server, updated
 * both locally and remotely, and evicted when the notebook closes.
 */
export class MarimoConfigurationService extends Effect.Service<MarimoConfigurationService>()(
  "MarimoConfigurationService",
  {
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const marimo = yield* MarimoClient;
      const editorRegistry = yield* NotebookEditorRegistry;

      // Track configurations: NotebookUri -> MarimoConfig
      const configRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, MarimoConfig>(),
      );
      const sessionTokens = new Map<NotebookId, object>();

      const tokenFor = (notebookUri: NotebookId) => {
        const existing = sessionTokens.get(notebookUri);
        if (existing) return existing;
        const token = {};
        sessionTokens.set(notebookUri, token);
        return token;
      };

      const clearNotebook = (notebookUri: NotebookId) =>
        Effect.gen(function* () {
          sessionTokens.delete(notebookUri);
          yield* SubscriptionRef.update(configRef, (map) =>
            HashMap.remove(map, notebookUri),
          );

          yield* Effect.logTrace("Cleared configuration cache").pipe(
            Effect.annotateLogs({ notebookUri }),
          );
        });

      // The kernel re-reads its config when a notebook session restarts, so a
      // closed notebook's cache entry would be stale if it were reopened.
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentClosed().pipe(
          Stream.runForEach((document) =>
            Option.match(MarimoNotebookDocument.tryFrom(document), {
              onNone: () => Effect.void,
              onSome: (notebook) => clearNotebook(notebook.id),
            }),
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
          configRef.changes,
          editorRegistry.streamActiveNotebookChanges(),
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
            const sessionToken = tokenFor(notebookUri);
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
            const cacheIsCurrent =
              sessionTokens.get(notebookUri) === sessionToken;
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
            const sessionToken = tokenFor(notebookUri);
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

            if (sessionTokens.get(notebookUri) === sessionToken) {
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
        clearNotebook,

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
) {}
