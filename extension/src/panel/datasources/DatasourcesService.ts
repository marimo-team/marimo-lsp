import { Effect, HashMap, SubscriptionRef } from "effect";

import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type {
  DataSourceConnectionsNotification,
  DatasetsNotification,
} from "../../types.ts";

/**
 * Maps for efficient lookups in the datasource hierarchy:
 * Connection -> Database -> Schema -> Table
 */

interface DataSourceConnectionMap {
  // connection name -> connection data
  connections: Map<
    string,
    {
      source: string;
      dialect: string;
      name: string;
      display_name: string;
      default_database: string | null;
      default_schema: string | null;
      databases: Map<
        string,
        {
          name: string;
          dialect: string;
          engine: string | null;
          schemas: Map<
            string,
            {
              name: string;
              tables: Map<string, DataTable>;
            }
          >;
        }
      >;
    }
  >;
}

interface DataTable {
  name: string;
  source: string;
  source_type: "catalog" | "connection" | "duckdb" | "local";
  num_rows: number | null;
  num_columns: number | null;
  variable_name: string | null;
  engine: string | null;
  type: "table" | "view";
  primary_keys: string[] | null;
  indexes: string[] | null;
  columns: Array<{
    name: string;
    type: string;
    external_type: string;
    sample_values: unknown[];
  }>;
}

interface DatasetsMap {
  // table name -> table data
  tables: Map<string, DataTable>;
  clear_channel: ("catalog" | "connection" | "duckdb" | "local") | null;
}

/**
 * Manages datasource state across all notebooks.
 *
 * Tracks:
 * 1. Data source connections (data-source-connections operation)
 * 2. Datasets (datasets operation)
 *
 * Uses SubscriptionRef for reactive state management.
 * Converts list-based data to Maps for efficient lookups.
 */
export class DatasourcesService extends Effect.Service<DatasourcesService>()(
  "DatasourcesService",
  {
    scoped: Effect.gen(function* () {
      // Track data source connections: NotebookUri -> DataSourceConnectionMap
      const connectionsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, DataSourceConnectionMap>(),
      );

      // Track datasets: NotebookUri -> DatasetsMap
      const datasetsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, DatasetsMap>(),
      );

      /**
       * Convert DataSourceConnection list to efficient map structure
       */
      const convertConnectionsToMap = (
        operation: DataSourceConnectionsNotification,
      ): DataSourceConnectionMap => {
        const connectionsMap = new Map();

        for (const conn of operation.connections) {
          const databasesMap = new Map();

          for (const db of conn.databases) {
            const schemasMap = new Map();

            for (const schema of db.schemas) {
              const tablesMap = new Map();
              for (const table of schema.tables) {
                tablesMap.set(table.name, table);
              }

              schemasMap.set(schema.name, {
                name: schema.name,
                tables: tablesMap,
              });
            }

            databasesMap.set(db.name, {
              name: db.name,
              dialect: db.dialect,
              engine: db.engine ?? null,
              schemas: schemasMap,
            });
          }

          connectionsMap.set(conn.name, {
            source: conn.source,
            dialect: conn.dialect,
            name: conn.name,
            display_name: conn.display_name,
            default_database: conn.default_database ?? null,
            default_schema: conn.default_schema ?? null,
            databases: databasesMap,
          });
        }

        return { connections: connectionsMap };
      };

      /**
       * Convert Datasets list to efficient map structure
       */
      const convertDatasetsToMap = (
        operation: DatasetsNotification,
      ): DatasetsMap => {
        const tablesMap = new Map();

        for (const table of operation.tables) {
          tablesMap.set(table.name, table);
        }

        return {
          tables: tablesMap,
          clear_channel: operation.clear_channel ?? null,
        };
      };

      return {
        /**
         * Update data source connections for a notebook
         */
        updateConnections(
          notebookUri: NotebookId,
          operation: DataSourceConnectionsNotification,
        ) {
          return Effect.gen(function* () {
            const connectionsMap = convertConnectionsToMap(operation);

            yield* SubscriptionRef.update(connectionsRef, (map) =>
              HashMap.set(map, notebookUri, connectionsMap),
            );

            yield* Effect.logTrace("Updated data source connections").pipe(
              Effect.annotateLogs({
                notebookUri,
                count: operation.connections.length,
              }),
            );
          });
        },

        /**
         * Update datasets for a notebook
         */
        updateDatasets(
          notebookUri: NotebookId,
          operation: DatasetsNotification,
        ) {
          return Effect.gen(function* () {
            const datasetsMap = convertDatasetsToMap(operation);

            yield* SubscriptionRef.update(datasetsRef, (map) =>
              HashMap.set(map, notebookUri, datasetsMap),
            );

            yield* Effect.logTrace("Updated datasets").pipe(
              Effect.annotateLogs({
                notebookUri,
                count: operation.tables.length,
                clear_channel: operation.clear_channel,
              }),
            );
          });
        },

        /**
         * Get data source connections for a notebook
         */
        getConnections(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(connectionsRef);
            return HashMap.get(map, notebookUri);
          });
        },

        /**
         * Get datasets for a notebook
         */
        getDatasets(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(datasetsRef);
            return HashMap.get(map, notebookUri);
          });
        },

        /**
         * Clear all datasource data for a notebook
         */
        clearNotebook(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(connectionsRef, (map) =>
              HashMap.remove(map, notebookUri),
            );
            yield* SubscriptionRef.update(datasetsRef, (map) =>
              HashMap.remove(map, notebookUri),
            );

            yield* Effect.logTrace("Cleared datasource data").pipe(
              Effect.annotateLogs({ notebookUri }),
            );
          });
        },

        /**
         * Stream of data source connection changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamConnectionsChanges() {
          return connectionsRef.changes;
        },

        /**
         * Stream of dataset changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamDatasetsChanges() {
          return datasetsRef.changes;
        },
      };
    }),
  },
) {}
