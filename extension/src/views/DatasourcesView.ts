import { Effect, Layer, Option, Ref, Stream } from "effect";
import { DatasourcesService } from "../services/datasources/DatasourcesService.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import type { NotebookUri } from "../types.ts";
import { Log } from "../utils/log.ts";
import { TreeView } from "./TreeView.ts";

type DatasourceTreeItem =
  | ConnectionItem
  | DatabaseItem
  | SchemaItem
  | TableItem;

interface ConnectionItem {
  type: "connection";
  notebookUri: NotebookUri;
  connectionName: string;
  displayName: string;
  dialect: string;
}

interface DatabaseItem {
  type: "database";
  notebookUri: NotebookUri;
  connectionName: string;
  databaseName: string;
  dialect: string;
}

interface SchemaItem {
  type: "schema";
  notebookUri: NotebookUri;
  connectionName: string;
  databaseName: string;
  schemaName: string;
}

interface TableItem {
  type: "table";
  notebookUri: NotebookUri;
  connectionName: string;
  databaseName: string;
  schemaName: string;
  tableName: string;
  tableType: "table" | "view";
  numRows: number | null;
  numColumns: number | null;
}

/**
 * Manages the datasources tree view for the active notebook.
 *
 * Displays a hierarchical view of data sources:
 * Connection → Database → Schema → Table
 *
 * Subscribes to datasource changes and updates the tree view in real-time.
 */
export const DatasourcesViewLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const treeView = yield* TreeView;
    const datasourcesService = yield* DatasourcesService;
    const editorRegistry = yield* NotebookEditorRegistry;

    // Track the current datasource items for the active notebook
    const datasourceItems = yield* Ref.make<readonly DatasourceTreeItem[]>([]);

    // Create the tree data provider
    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-datasources",
      getChildren: (element?: DatasourceTreeItem) =>
        Effect.gen(function* () {
          if (!element) {
            // Root level: return connections
            const items = yield* Ref.get(datasourceItems);
            return items.filter((item) => item.type === "connection");
          }

          const activeNotebookUri =
            yield* editorRegistry.getActiveNotebookUri();
          if (Option.isNone(activeNotebookUri)) {
            return [];
          }

          const notebookUri = activeNotebookUri.value;
          const items = yield* Ref.get(datasourceItems);

          if (element.type === "connection") {
            // Get databases for this connection
            // For in-memory connection, just filter from items (no need to query datasourcesService)
            if (element.connectionName === "__in_memory") {
              return items.filter(
                (item) =>
                  item.type === "database" &&
                  item.connectionName === element.connectionName,
              );
            }

            // For regular connections, filter from items
            const connections =
              yield* datasourcesService.getConnections(notebookUri);
            if (Option.isNone(connections)) {
              return [];
            }

            const connectionsMap = connections.value;
            const conn = connectionsMap.connections.get(element.connectionName);
            if (!conn) return [];

            return items.filter(
              (item) =>
                item.type === "database" &&
                item.connectionName === element.connectionName,
            );
          }

          if (element.type === "database") {
            // Get schemas for this database
            // For in-memory connection, just filter from items
            if (element.connectionName === "__in_memory") {
              return items.filter(
                (item) =>
                  item.type === "schema" &&
                  item.connectionName === element.connectionName &&
                  item.databaseName === element.databaseName,
              );
            }

            // For regular connections, check if database exists
            const connections =
              yield* datasourcesService.getConnections(notebookUri);
            if (Option.isNone(connections)) {
              return [];
            }

            const connectionsMap = connections.value;
            const conn = connectionsMap.connections.get(element.connectionName);
            if (!conn) return [];

            const db = conn.databases.get(element.databaseName);
            if (!db) return [];

            return items.filter(
              (item) =>
                item.type === "schema" &&
                item.connectionName === element.connectionName &&
                item.databaseName === element.databaseName,
            );
          }

          if (element.type === "schema") {
            // Get tables for this schema
            // For in-memory connection, just filter from items
            if (element.connectionName === "__in_memory") {
              return items.filter(
                (item) =>
                  item.type === "table" &&
                  item.connectionName === element.connectionName &&
                  item.databaseName === element.databaseName &&
                  item.schemaName === element.schemaName,
              );
            }

            // For regular connections, check if schema exists
            const connections =
              yield* datasourcesService.getConnections(notebookUri);
            if (Option.isNone(connections)) {
              return [];
            }

            const connectionsMap = connections.value;
            const conn = connectionsMap.connections.get(element.connectionName);
            if (!conn) return [];

            const db = conn.databases.get(element.databaseName);
            if (!db) return [];

            const schema = db.schemas.get(element.schemaName);
            if (!schema) return [];

            return items.filter(
              (item) =>
                item.type === "table" &&
                item.connectionName === element.connectionName &&
                item.databaseName === element.databaseName &&
                item.schemaName === element.schemaName,
            );
          }

          return [];
        }),
      getTreeItem: (element: DatasourceTreeItem) =>
        Effect.succeed({
          label:
            element.type === "connection"
              ? element.displayName
              : element.type === "database"
                ? element.databaseName
                : element.type === "schema"
                  ? element.schemaName
                  : element.tableName,
          description:
            element.type === "connection"
              ? element.dialect
              : element.type === "database"
                ? element.dialect
                : element.type === "table"
                  ? element.numRows !== null
                    ? `${element.numRows} rows`
                    : undefined
                  : undefined,
          tooltip:
            element.type === "connection"
              ? `${element.displayName} (${element.dialect})`
              : element.type === "database"
                ? `${element.databaseName} (${element.dialect})`
                : element.type === "schema"
                  ? element.schemaName
                  : element.type === "table"
                    ? `${element.tableName} (${element.tableType})${element.numRows !== null ? `\n${element.numRows} rows` : ""}${element.numColumns !== null ? `, ${element.numColumns} columns` : ""}`
                    : undefined,
          iconPath: undefined,
          contextValue:
            element.type === "connection"
              ? "marimoConnection"
              : element.type === "database"
                ? "marimoDatabase"
                : element.type === "schema"
                  ? "marimoSchema"
                  : "marimoTable",
          collapsibleState:
            element.type === "table"
              ? ("None" as const)
              : ("Collapsed" as const),
        }),
    });

    // Helper to rebuild the datasources list from current state
    const refreshDatasources = Effect.fnUntraced(function* () {
      const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri();

      yield* Log.info("Refreshing datasources", {
        activeNotebookUri: Option.getOrElse(activeNotebookUri, () => null),
      });
      if (Option.isNone(activeNotebookUri)) {
        yield* Ref.set(datasourceItems, []);
        yield* provider.refresh();
        return;
      }

      const notebookUri = activeNotebookUri.value;
      const connections = yield* datasourcesService.getConnections(notebookUri);
      const datasets = yield* datasourcesService.getDatasets(notebookUri); // in-memory datasources

      const connectionsMap = Option.getOrElse(connections, () => ({
        connections: new Map(),
      }));
      const datasetsMap = Option.getOrElse(datasets, () => ({
        tables: new Map(),
        clear_channel: null,
      }));

      const items: DatasourceTreeItem[] = [];

      // Build hierarchical tree items for connections
      for (const [connName, conn] of connectionsMap.connections) {
        items.push({
          type: "connection",
          notebookUri,
          connectionName: connName,
          displayName: conn.display_name,
          dialect: conn.dialect,
        });

        for (const [dbName, db] of conn.databases) {
          items.push({
            type: "database",
            notebookUri,
            connectionName: connName,
            databaseName: dbName,
            dialect: db.dialect,
          });

          for (const [schemaName, schema] of db.schemas) {
            items.push({
              type: "schema",
              notebookUri,
              connectionName: connName,
              databaseName: dbName,
              schemaName: schemaName,
            });

            for (const [tableName, table] of schema.tables) {
              items.push({
                type: "table",
                notebookUri,
                connectionName: connName,
                databaseName: dbName,
                schemaName: schemaName,
                tableName: tableName,
                tableType: table.type,
                numRows: table.num_rows,
                numColumns: table.num_columns,
              });
            }
          }
        }
      }

      // Add in-memory datasets as a special connection
      if (datasetsMap.tables.size > 0) {
        const inMemoryConnName = "__in_memory";
        const inMemoryDbName = "default";
        const inMemorySchemaName = "default";

        items.push({
          type: "connection",
          notebookUri,
          connectionName: inMemoryConnName,
          displayName: "In-memory",
          dialect: "python",
        });

        items.push({
          type: "database",
          notebookUri,
          connectionName: inMemoryConnName,
          databaseName: inMemoryDbName,
          dialect: "python",
        });

        items.push({
          type: "schema",
          notebookUri,
          connectionName: inMemoryConnName,
          databaseName: inMemoryDbName,
          schemaName: inMemorySchemaName,
        });

        for (const [tableName, table] of datasetsMap.tables) {
          items.push({
            type: "table",
            notebookUri,
            connectionName: inMemoryConnName,
            databaseName: inMemoryDbName,
            schemaName: inMemorySchemaName,
            tableName: tableName,
            tableType: table.type,
            numRows: table.num_rows,
            numColumns: table.num_columns,
          });
        }
      }

      yield* Log.info("Refreshed datasources", {
        connections: connectionsMap.connections.size,
        inMemoryTables: datasetsMap.tables.size,
        totalItems: items.length,
      });
      yield* Ref.set(datasourceItems, items);
      yield* provider.refresh();
    });

    // Subscribe to active notebook changes
    yield* Effect.forkScoped(
      editorRegistry.streamActiveNotebookChanges().pipe(
        Stream.mapEffect(() => {
          return refreshDatasources();
        }),
        Stream.runDrain,
      ),
    );

    // Subscribe to datasource connection changes
    yield* Effect.forkScoped(
      datasourcesService.streamConnectionsChanges().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (_connectionsMap) {
            yield* refreshDatasources();
          }),
        ),
        Stream.runDrain,
      ),
    );

    // Subscribe to dataset changes
    yield* Effect.forkScoped(
      datasourcesService.streamDatasetsChanges().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (_datasetsMap) {
            yield* refreshDatasources();
          }),
        ),
        Stream.runDrain,
      ),
    );

    // Initialize with current state
    yield* Effect.forkScoped(refreshDatasources());

    yield* Effect.logInfo("Datasources view initialized");
  }),
);
