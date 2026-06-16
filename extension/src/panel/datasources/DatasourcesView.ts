import { Effect, Layer, Option, Ref, Stream } from "effect";

import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import { TreeView } from "../TreeView.ts";
import {
  type CatalogTreeNode,
  DatasourcesService,
} from "./DatasourcesService.ts";

type DatasourceTreeItem = ConnectionItem | DatabaseItem | CatalogNodeItem;

interface ConnectionItem {
  type: "connection";
  notebookUri: NotebookId;
  connectionName: string;
  displayName: string;
  dialect: string;
}

interface DatabaseItem {
  type: "database";
  notebookUri: NotebookId;
  connectionName: string;
  databaseName: string;
  dialect: string;
}

/**
 * A node in a database's recursive catalog tree: a `schema`/`namespace`
 * container or a `data_table` leaf. `path` is the list of node names from the
 * database root down to (and including) this node, which uniquely identifies it
 * and lets us recover its parent/children by prefix.
 */
interface CatalogNodeItem {
  type: "catalog-node";
  notebookUri: NotebookId;
  connectionName: string;
  databaseName: string;
  path: string[];
  kind: "schema" | "namespace" | "data_table";
  name: string;
  tableType: "table" | "view" | null;
  numRows: number | null;
  numColumns: number | null;
}

/** True when `child` sits directly beneath `parent` in the same db/connection. */
function isDirectChild(
  parent: CatalogNodeItem,
  child: CatalogNodeItem,
): boolean {
  return (
    child.connectionName === parent.connectionName &&
    child.databaseName === parent.databaseName &&
    child.path.length === parent.path.length + 1 &&
    parent.path.every((segment, i) => child.path[i] === segment)
  );
}

/**
 * Manages the datasources tree view for the active notebook.
 *
 * Displays a hierarchical view of data sources:
 * Connection → Database → (Schema | Namespace)* → Table
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
          const items = yield* Ref.get(datasourceItems);

          // Root level: return connections
          if (!element) {
            return items.filter((item) => item.type === "connection");
          }

          if (element.type === "connection") {
            return items.filter(
              (item) =>
                item.type === "database" &&
                item.connectionName === element.connectionName,
            );
          }

          if (element.type === "database") {
            // Top-level catalog nodes for this database (path length 1).
            return items.filter(
              (item) =>
                item.type === "catalog-node" &&
                item.connectionName === element.connectionName &&
                item.databaseName === element.databaseName &&
                item.path.length === 1,
            );
          }

          // catalog-node: leaves have no children; containers expose their
          // direct descendants.
          if (element.kind === "data_table") {
            return [];
          }
          return items.filter(
            (item) =>
              item.type === "catalog-node" && isDirectChild(element, item),
          );
        }),
      getTreeItem: (element: DatasourceTreeItem) =>
        Effect.succeed({
          label:
            element.type === "connection"
              ? element.displayName
              : element.type === "database"
                ? element.databaseName
                : element.name,
          description:
            element.type === "connection"
              ? element.dialect
              : element.type === "database"
                ? element.dialect
                : element.type === "catalog-node" &&
                    element.kind === "data_table" &&
                    element.numRows !== null
                  ? `${element.numRows} rows`
                  : undefined,
          tooltip:
            element.type === "connection"
              ? `${element.displayName} (${element.dialect})`
              : element.type === "database"
                ? `${element.databaseName} (${element.dialect})`
                : element.kind === "data_table"
                  ? `${element.name} (${element.tableType ?? "table"})${element.numRows !== null ? `\n${element.numRows} rows` : ""}${element.numColumns !== null ? `, ${element.numColumns} columns` : ""}`
                  : element.name,
          iconPath: undefined,
          contextValue:
            element.type === "connection"
              ? "marimoConnection"
              : element.type === "database"
                ? "marimoDatabase"
                : element.kind === "data_table"
                  ? "marimoTable"
                  : element.kind === "namespace"
                    ? "marimoNamespace"
                    : "marimoSchema",
          collapsibleState:
            element.type === "catalog-node" && element.kind === "data_table"
              ? ("None" as const)
              : ("Collapsed" as const),
        }),
    });

    // Walk a database's catalog tree into flat `CatalogNodeItem`s, accumulating
    // each node's path from the database root.
    const collectCatalogNodes = (params: {
      notebookUri: NotebookId;
      connectionName: string;
      databaseName: string;
      nodes: readonly CatalogTreeNode[];
      parentPath: readonly string[];
    }): CatalogNodeItem[] => {
      const { notebookUri, connectionName, databaseName, nodes, parentPath } =
        params;
      const out: CatalogNodeItem[] = [];
      for (const node of nodes) {
        const path = [...parentPath, node.name];
        out.push({
          type: "catalog-node",
          notebookUri,
          connectionName,
          databaseName,
          path,
          kind: node.kind,
          name: node.name,
          tableType: node.table?.type ?? null,
          numRows: node.table?.num_rows ?? null,
          numColumns: node.table?.num_columns ?? null,
        });
        out.push(
          ...collectCatalogNodes({
            notebookUri,
            connectionName,
            databaseName,
            nodes: node.children,
            parentPath: path,
          }),
        );
      }
      return out;
    };

    // Helper to rebuild the datasources list from current state
    const refreshDatasources = Effect.fn(function* () {
      const activeNotebookUri = yield* editorRegistry.getActiveNotebookUri();

      yield* Effect.logTrace("Refreshing datasources").pipe(
        Effect.annotateLogs({
          activeNotebookUri: Option.getOrElse(activeNotebookUri, () => null),
        }),
      );

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

          items.push(
            ...collectCatalogNodes({
              notebookUri,
              connectionName: connName,
              databaseName: dbName,
              nodes: db.children,
              parentPath: [],
            }),
          );
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
          type: "catalog-node",
          notebookUri,
          connectionName: inMemoryConnName,
          databaseName: inMemoryDbName,
          path: [inMemorySchemaName],
          kind: "schema",
          name: inMemorySchemaName,
          tableType: null,
          numRows: null,
          numColumns: null,
        });

        for (const [tableName, table] of datasetsMap.tables) {
          items.push({
            type: "catalog-node",
            notebookUri,
            connectionName: inMemoryConnName,
            databaseName: inMemoryDbName,
            path: [inMemorySchemaName, tableName],
            kind: "data_table",
            name: tableName,
            tableType: table.type,
            numRows: table.num_rows,
            numColumns: table.num_columns,
          });
        }
      }

      yield* Effect.logTrace("Refreshed datasources").pipe(
        Effect.annotateLogs({
          connections: connectionsMap.connections.size,
          inMemoryTables: datasetsMap.tables.size,
          totalItems: items.length,
        }),
      );
      yield* Ref.set(datasourceItems, items);
      yield* provider.refresh();
    });

    // Subscribe to active notebook changes
    yield* Effect.forkScoped(
      editorRegistry.streamActiveNotebookChanges().pipe(
        Stream.runForEach(() => {
          return refreshDatasources();
        }),
      ),
    );

    // Subscribe to datasource connection changes
    yield* Effect.forkScoped(
      datasourcesService.streamConnectionsChanges().pipe(
        Stream.runForEach(
          Effect.fn(function* (_connectionsMap) {
            yield* refreshDatasources();
          }),
        ),
      ),
    );

    // Subscribe to dataset changes
    yield* Effect.forkScoped(
      datasourcesService.streamDatasetsChanges().pipe(
        Stream.runForEach(
          Effect.fn(function* (_datasetsMap) {
            yield* refreshDatasources();
          }),
        ),
      ),
    );

    yield* Effect.logDebug("Datasources view initialized");
  }),
);
