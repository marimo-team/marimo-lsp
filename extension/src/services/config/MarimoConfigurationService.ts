import {
  Effect,
  HashMap,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { MarimoConfigResponseSchema } from "../../schemas/config.ts";
import type { MarimoConfig, NotebookUri } from "../../types.ts";
import { Log } from "../../utils/log.ts";
import { LanguageClient } from "../LanguageClient.ts";
import { NotebookEditorRegistry } from "../NotebookEditorRegistry.ts";

/**
 * Manages marimo configuration state across all notebooks.
 *
 * Tracks configuration for each notebook using SubscriptionRef for reactive state management.
 * Configurations are fetched from the LSP server and can be updated both locally and remotely.
 */
export class MarimoConfigurationService extends Effect.Service<MarimoConfigurationService>()(
  "MarimoConfigurationService",
  {
    scoped: Effect.gen(function* () {
      const editorRegistry = yield* NotebookEditorRegistry;

      // Track configurations: NotebookUri -> MarimoConfig
      const configRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookUri, MarimoConfig>(),
      );

      const client = yield* LanguageClient;

      return {
        /**
         * Get the configuration for a notebook
         */
        getConfig(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            // First check if we have it cached
            const map = yield* SubscriptionRef.get(configRef);
            const cached = HashMap.get(map, notebookUri);

            if (Option.isSome(cached)) {
              return cached.value;
            }

            // Fetch from LSP server
            yield* Log.trace("Fetching configuration from LSP", {
              notebookUri,
            });

            const result = yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "get_configuration",
                params: {
                  notebookUri,
                  inner: {},
                },
              },
            });

            const config = yield* Schema.decodeUnknown(
              MarimoConfigResponseSchema,
            )(result);

            // Cache the result
            yield* SubscriptionRef.update(configRef, (map) =>
              HashMap.set(map, notebookUri, config.config),
            );

            yield* Log.trace("Configuration fetched and cached", {
              notebookUri,
            });

            return config.config;
          });
        },

        /**
         * Update the configuration for a notebook
         */
        updateConfig(
          notebookUri: NotebookUri,
          partialConfig: Record<string, unknown>,
        ) {
          return Effect.gen(function* () {
            yield* Log.trace("Updating configuration", {
              notebookUri,
              config: partialConfig,
            });

            // Send update to LSP server
            const result = yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "update_configuration",
                params: {
                  notebookUri,
                  inner: {
                    config: partialConfig,
                  },
                },
              },
            });

            const config = yield* Schema.decodeUnknown(
              MarimoConfigResponseSchema,
            )(result);

            // Update cached config
            yield* SubscriptionRef.update(configRef, (map) =>
              HashMap.set(map, notebookUri, config.config),
            );

            yield* Log.trace("Configuration updated successfully", {
              notebookUri,
            });

            return config.config;
          });
        },

        /**
         * Get cached configuration for a notebook (if available)
         */
        getCachedConfig(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(configRef);
            return HashMap.get(map, notebookUri);
          });
        },

        /**
         * Clear configuration for a notebook
         */
        clearNotebook(notebookUri: NotebookUri) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(configRef, (map) =>
              HashMap.remove(map, notebookUri),
            );

            yield* Log.trace("Cleared configuration cache", { notebookUri });
          });
        },

        /**
         * Cleanup the configuration service
         */
        cleanup() {
          return SubscriptionRef.set(configRef, HashMap.empty());
        },

        /**
         * Stream of configuration changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamConfigChanges() {
          return configRef.changes.pipe(Stream.changes);
        },

        /**
         * Stream of configuration changes for the active notebook.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamActiveConfigChanges() {
          return Stream.zipLatest(
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
        },

        /**
         * Stream of mapped configuration values for the active notebook.
         *
         * Emits the current value on subscription, then all subsequent changes.
         * Filters consecutive duplicates via Stream.changes.
         */
        streamOf<R>(
          mapper: (config: MarimoConfig) => R,
        ): Stream.Stream<Option.Option<R>> {
          return this.streamActiveConfigChanges().pipe(
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
