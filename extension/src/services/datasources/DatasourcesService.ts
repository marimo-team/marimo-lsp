import { Effect, HashMap, SubscriptionRef } from "effect";
import type { NotebookId } from "../../schemas.ts";
import type {
  DataColumnPreviewNotification,
  DataSourceConnectionsNotification,
  DatasetsNotification,
  SqlTableListPreviewNotification,
  SqlTablePreviewNotification,
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
 * 3. SQL table previews (sql-table-preview operation)
 * 4. SQL table list previews (sql-table-list-preview operation)
 * 5. Data column previews (data-column-preview operation)
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

      // Track SQL table previews: NotebookUri -> Map<request_id, table>
      const tablePreviewsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, Map<string, DataTable | null>>(),
      );

      // Track SQL table list previews: NotebookUri -> Map<request_id, tables[]>
      const tableListPreviewsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, Map<string, DataTable[]>>(),
      );

      // Track column previews: NotebookUri -> Map<table_name, ColumnStats>
      const columnPreviewsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, Map<string, unknown>>(),
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
         * Update SQL table preview for a notebook
         */
        updateTablePreview(
          notebookUri: NotebookId,
          operation: SqlTablePreviewNotification,
        ) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(tablePreviewsRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const previewMap =
                existing._tag === "Some" ? existing.value : new Map();

              previewMap.set(operation.request_id, operation.table);

              return HashMap.set(map, notebookUri, previewMap);
            });

            yield* Effect.logTrace("Updated table preview").pipe(
              Effect.annotateLogs({
                notebookUri,
                request_id: operation.request_id,
                has_table: operation.table !== null,
              }),
            );
          });
        },

        /**
         * Update SQL table list preview for a notebook
         */
        updateTableListPreview(
          notebookUri: NotebookId,
          operation: SqlTableListPreviewNotification,
        ) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(tableListPreviewsRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const previewMap =
                existing._tag === "Some" ? existing.value : new Map();

              previewMap.set(operation.request_id, operation.tables ?? []);

              return HashMap.set(map, notebookUri, previewMap);
            });

            yield* Effect.logTrace("Updated table list preview").pipe(
              Effect.annotateLogs({
                notebookUri,
                request_id: operation.request_id,
                count: operation.tables?.length ?? 0,
              }),
            );
          });
        },

        /**
         * Update column preview for a notebook
         */
        updateColumnPreview(
          notebookUri: NotebookId,
          operation: DataColumnPreviewNotification,
        ) {
          return Effect.gen(function* () {
            yield* SubscriptionRef.update(columnPreviewsRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const previewMap =
                existing._tag === "Some" ? existing.value : new Map();

              if (operation.table_name) {
                previewMap.set(operation.table_name, operation.stats);
              }

              return HashMap.set(map, notebookUri, previewMap);
            });

            yield* Effect.logTrace("Updated column preview").pipe(
              Effect.annotateLogs({
                notebookUri,
                table_name: operation.table_name,
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
         * Get table preview for a notebook and request ID
         */
        getTablePreview(notebookUri: NotebookId, requestId: string) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(tablePreviewsRef);
            const previewMap = HashMap.get(map, notebookUri);
            if (previewMap._tag === "Some") {
              return previewMap.value.get(requestId) ?? null;
            }
            return null;
          });
        },

        /**
         * Get table list preview for a notebook and request ID
         */
        getTableListPreview(notebookUri: NotebookId, requestId: string) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(tableListPreviewsRef);
            const previewMap = HashMap.get(map, notebookUri);
            if (previewMap._tag === "Some") {
              return previewMap.value.get(requestId) ?? [];
            }
            return [];
          });
        },

        /**
         * Get column preview for a notebook and table name
         */
        getColumnPreview(notebookUri: NotebookId, tableName: string) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(columnPreviewsRef);
            const previewMap = HashMap.get(map, notebookUri);
            if (previewMap._tag === "Some") {
              return previewMap.value.get(tableName) ?? null;
            }
            return null;
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
            yield* SubscriptionRef.update(tablePreviewsRef, (map) =>
              HashMap.remove(map, notebookUri),
            );
            yield* SubscriptionRef.update(tableListPreviewsRef, (map) =>
              HashMap.remove(map, notebookUri),
            );
            yield* SubscriptionRef.update(columnPreviewsRef, (map) =>
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

        /**
         * Stream of table preview changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamTablePreviewsChanges() {
          return tablePreviewsRef.changes;
        },

        /**
         * Stream of table list preview changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamTableListPreviewsChanges() {
          return tableListPreviewsRef.changes;
        },

        /**
         * Stream of column preview changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamColumnPreviewsChanges() {
          return columnPreviewsRef.changes;
        },
      };
    }),
  },
) {}
