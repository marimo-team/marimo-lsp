import { Effect, HashMap, SubscriptionRef } from "effect";

import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type {
  CatalogChildrenPreviewNotification,
  CatalogNode,
  DataColumnPreviewNotification,
  DataSourceConnectionsNotification,
  DatasetsNotification,
  DataTableNode,
  SqlTablePreviewNotification,
} from "../../types.ts";

/**
 * Maps for efficient lookups in the datasource hierarchy:
 * Connection -> Database -> CatalogTreeNode tree.
 */

/**
 * Normalized catalog tree node. Container nodes (`schema`, `namespace`) carry
 * their resolved `children`; `data_table` leaves carry their `table` payload.
 *
 * Deferred buckets on the wire (`children`/`tables` === null) are normalized to
 * an empty `children` array — the panel renders what the kernel has discovered
 * and does not itself drive lazy catalog fetches.
 */
export interface CatalogTreeNode {
  kind: "schema" | "namespace" | "data_table";
  name: string;
  children: CatalogTreeNode[];
  table: DataTableNode | null;
}

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
          children: CatalogTreeNode[];
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
 * 4. Catalog children previews (catalog-children-preview operation)
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

      // Track catalog children previews: NotebookUri -> Map<request_id, nodes[]>
      const catalogChildrenPreviewsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, Map<string, CatalogTreeNode[]>>(),
      );

      // Track column previews: NotebookUri -> Map<table_name, ColumnStats>
      const columnPreviewsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, Map<string, unknown>>(),
      );

      /**
       * Normalize a wire catalog node into the panel's `CatalogTreeNode`.
       *
       * Recurses through `schema.tables` and `namespace.children`, flattening a
       * deferred (`null`) bucket to an empty child list.
       */
      const normalizeCatalogNode = (node: CatalogNode): CatalogTreeNode => {
        switch (node.kind) {
          case "schema":
            return {
              kind: "schema",
              name: node.name,
              children: (node.tables ?? []).map(normalizeCatalogNode),
              table: null,
            };
          case "namespace":
            return {
              kind: "namespace",
              name: node.name,
              children: (node.children ?? []).map(normalizeCatalogNode),
              table: null,
            };
          default:
            // data_table leaf
            return {
              kind: "data_table",
              name: node.name,
              children: [],
              table: node,
            };
        }
      };

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
            databasesMap.set(db.name, {
              name: db.name,
              dialect: db.dialect,
              engine: db.engine ?? null,
              children: (db.children ?? []).map(normalizeCatalogNode),
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
         * Update catalog children preview for a notebook.
         *
         * Skips updates that carry an error so a transient failure doesn't
         * erase previously cached children.
         */
        updateCatalogChildrenPreview(
          notebookUri: NotebookId,
          operation: CatalogChildrenPreviewNotification,
        ) {
          return Effect.gen(function* () {
            if (operation.error != null) {
              yield* Effect.logWarning("Catalog children preview failed").pipe(
                Effect.annotateLogs({
                  notebookUri,
                  request_id: operation.request_id,
                  error: operation.error,
                }),
              );
              return;
            }

            const children = (operation.children ?? []).map(
              normalizeCatalogNode,
            );

            yield* SubscriptionRef.update(catalogChildrenPreviewsRef, (map) => {
              const existing = HashMap.get(map, notebookUri);
              const previewMap =
                existing._tag === "Some" ? existing.value : new Map();

              previewMap.set(operation.request_id, children);

              return HashMap.set(map, notebookUri, previewMap);
            });

            yield* Effect.logTrace("Updated catalog children preview").pipe(
              Effect.annotateLogs({
                notebookUri,
                request_id: operation.request_id,
                count: children.length,
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
         * Get catalog children preview for a notebook and request ID
         */
        getCatalogChildrenPreview(notebookUri: NotebookId, requestId: string) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(catalogChildrenPreviewsRef);
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
            yield* SubscriptionRef.update(catalogChildrenPreviewsRef, (map) =>
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
         * Stream of catalog children preview changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamCatalogChildrenPreviewsChanges() {
          return catalogChildrenPreviewsRef.changes;
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
