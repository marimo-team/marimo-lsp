import { Effect, Layer, Option, Stream } from "effect";

import { unreachable } from "../../assert.ts";
import { NotebookDocumentSessions } from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { DataTable } from "../../types.ts";
import { TreeView } from "../TreeView.ts";
import {
  type DatasourceDatabase,
  type DatasourceSchema,
  DatasourcesService,
} from "./DatasourcesService.ts";

const IN_MEMORY_CONNECTION = "__in_memory";
const IN_MEMORY_DATABASE = "default";
const IN_MEMORY_SCHEMA = "default";

type DatasourceTreeItem =
  | ConnectionItem
  | DatabaseItem
  | SchemaItem
  | TableItem;

interface ConnectionItem {
  readonly type: "connection";
  readonly notebookUri: NotebookId;
  readonly connectionName: string;
  readonly displayName: string;
  readonly dialect: string;
}

interface DatabaseItem {
  readonly type: "database";
  readonly notebookUri: NotebookId;
  readonly connectionName: string;
  readonly databaseName: string;
  readonly dialect: string;
}

interface SchemaItem {
  readonly type: "schema";
  readonly notebookUri: NotebookId;
  readonly connectionName: string;
  readonly databaseName: string;
  readonly schemaPath: readonly string[];
  readonly schemaName: string;
}

interface TableItem {
  readonly type: "table";
  readonly notebookUri: NotebookId;
  readonly connectionName: string;
  readonly databaseName: string;
  readonly schemaPath: readonly string[];
  readonly tableName: string;
  readonly tableType: "table" | "view";
  readonly numRows: number | null;
  readonly numColumns: number | null;
}

const findSchema = (
  database: DatasourceDatabase,
  path: readonly string[],
): DatasourceSchema | undefined => {
  let schemas = database.schemas;
  let current: DatasourceSchema | undefined;
  for (const name of path) {
    current = schemas.get(name);
    if (current === undefined) return undefined;
    schemas = current.childSchemas;
  }
  return current;
};

const schemaItem = (
  parent: DatabaseItem | SchemaItem,
  schema: DatasourceSchema,
  path: readonly string[],
): SchemaItem => ({
  type: "schema",
  notebookUri: parent.notebookUri,
  connectionName: parent.connectionName,
  databaseName: parent.databaseName,
  schemaPath: path,
  schemaName: schema.name,
});

const tableItem = (
  parent: DatabaseItem | SchemaItem,
  table: DataTable,
  schemaPath: readonly string[],
): TableItem => ({
  type: "table",
  notebookUri: parent.notebookUri,
  connectionName: parent.connectionName,
  databaseName: parent.databaseName,
  schemaPath,
  tableName: table.name,
  tableType: table.type ?? "table",
  numRows: table.num_rows,
  numColumns: table.num_columns,
});

const itemId = (item: DatasourceTreeItem): string => {
  switch (item.type) {
    case "connection":
      return JSON.stringify([item.notebookUri, item.type, item.connectionName]);
    case "database":
      return JSON.stringify([
        item.notebookUri,
        item.type,
        item.connectionName,
        item.databaseName,
      ]);
    case "schema":
      return JSON.stringify([
        item.notebookUri,
        item.type,
        item.connectionName,
        item.databaseName,
        item.schemaPath,
      ]);
    case "table":
      return JSON.stringify([
        item.notebookUri,
        item.type,
        item.connectionName,
        item.databaseName,
        item.schemaPath,
        item.tableName,
      ]);
  }

  return unreachable(item);
};

/**
 * Manages the datasources tree view for the active notebook.
 *
 * Displays recursive SQL schemas and loads deferred schemas/tables when their
 * parent is expanded. In-memory datasets remain an eager synthetic branch.
 */
export const DatasourcesViewLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const treeView = yield* TreeView;
    const datasources = yield* DatasourcesService;
    const editors = yield* NotebookEditorRegistry;
    const documentSessions = yield* NotebookDocumentSessions;

    const getDatabase = Effect.fn(function* (item: DatabaseItem | SchemaItem) {
      const connections = yield* datasources.getConnections(item.notebookUri);
      if (Option.isNone(connections)) return undefined;
      return connections.value.connections
        .get(item.connectionName)
        ?.databases.get(item.databaseName);
    });

    const ignoreExpansionError = <A, E>(effect: Effect.Effect<A, E>) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Failed to expand datasource tree").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      );

    const loadDatabaseSchemas = Effect.fn(function* (
      item: DatabaseItem,
      database: DatasourceDatabase,
    ) {
      const session = documentSessions.current(item.notebookUri);
      if (Option.isNone(session)) return [];
      if (!database.schemasResolved) {
        yield* ignoreExpansionError(
          datasources.loadSchemas(
            session.value,
            item.connectionName,
            item.databaseName,
            [],
          ),
        );
      }

      let current = yield* getDatabase(item);
      if (current === undefined) return [];

      const children: DatasourceTreeItem[] = [];
      for (const schema of current.schemas.values()) {
        if (schema.name !== "") {
          children.push(schemaItem(item, schema, [schema.name]));
          continue;
        }

        // Schemaless databases expose their tables directly below the database.
        if (!schema.tablesResolved) {
          const session = documentSessions.current(item.notebookUri);
          if (Option.isSome(session)) {
            yield* ignoreExpansionError(
              datasources.loadTables(
                session.value,
                item.connectionName,
                item.databaseName,
                schema.name,
                [],
              ),
            );
          }
          current = yield* getDatabase(item);
        }
        const schemaless = current?.schemas.get("");
        if (schemaless !== undefined) {
          children.push(
            ...[...schemaless.tables.values()].map((table) =>
              tableItem(item, table, []),
            ),
          );
        }
      }
      return children;
    });

    const loadSchemaChildren = Effect.fn(function* (item: SchemaItem) {
      const database = yield* getDatabase(item);
      const schema = database && findSchema(database, item.schemaPath);
      if (schema === undefined) return [];

      const loads: Array<Effect.Effect<unknown>> = [];
      const session = documentSessions.current(item.notebookUri);
      if (Option.isNone(session)) return [];
      if (!schema.childSchemasResolved) {
        loads.push(
          ignoreExpansionError(
            datasources.loadSchemas(
              session.value,
              item.connectionName,
              item.databaseName,
              item.schemaPath,
            ),
          ),
        );
      }
      if (!schema.tablesResolved) {
        loads.push(
          ignoreExpansionError(
            datasources.loadTables(
              session.value,
              item.connectionName,
              item.databaseName,
              item.schemaName,
              item.schemaPath,
            ),
          ),
        );
      }
      yield* Effect.all(loads, { concurrency: "unbounded", discard: true });

      const currentDatabase = yield* getDatabase(item);
      const current =
        currentDatabase && findSchema(currentDatabase, item.schemaPath);
      if (current === undefined) return [];
      return [
        ...[...current.childSchemas.values()].map((child) =>
          schemaItem(item, child, [...item.schemaPath, child.name]),
        ),
        ...[...current.tables.values()].map((table) =>
          tableItem(item, table, item.schemaPath),
        ),
      ];
    });

    const provider = yield* treeView.createTreeDataProvider({
      viewId: "marimo-explorer-datasources",
      getChildren: (element?: DatasourceTreeItem) =>
        Effect.gen(function* () {
          if (element === undefined) {
            const active = yield* editors.getActiveNotebookUri;
            if (Option.isNone(active)) return [];
            const notebookUri = active.value;
            const connections = yield* datasources.getConnections(notebookUri);
            const datasets = yield* datasources.getDatasets(notebookUri);
            const items: ConnectionItem[] = [];

            if (Option.isSome(connections)) {
              for (const connection of connections.value.connections.values()) {
                items.push({
                  type: "connection",
                  notebookUri,
                  connectionName: connection.name,
                  displayName: connection.display_name,
                  dialect: connection.dialect,
                });
              }
            }
            if (Option.isSome(datasets) && datasets.value.tables.size > 0) {
              items.push({
                type: "connection",
                notebookUri,
                connectionName: IN_MEMORY_CONNECTION,
                displayName: "In-memory",
                dialect: "python",
              });
            }
            return items;
          }

          if (element.type === "connection") {
            if (element.connectionName === IN_MEMORY_CONNECTION) {
              return [
                {
                  type: "database" as const,
                  notebookUri: element.notebookUri,
                  connectionName: element.connectionName,
                  databaseName: IN_MEMORY_DATABASE,
                  dialect: "python",
                },
              ];
            }
            const connections = yield* datasources.getConnections(
              element.notebookUri,
            );
            const connection = Option.isSome(connections)
              ? connections.value.connections.get(element.connectionName)
              : undefined;
            if (connection === undefined) return [];
            return [...connection.databases.values()].map((database) => ({
              type: "database" as const,
              notebookUri: element.notebookUri,
              connectionName: element.connectionName,
              databaseName: database.name,
              dialect: database.dialect,
            }));
          }

          if (element.type === "database") {
            if (element.connectionName === IN_MEMORY_CONNECTION) {
              return [
                {
                  type: "schema" as const,
                  notebookUri: element.notebookUri,
                  connectionName: element.connectionName,
                  databaseName: element.databaseName,
                  schemaPath: [IN_MEMORY_SCHEMA],
                  schemaName: IN_MEMORY_SCHEMA,
                },
              ];
            }
            const database = yield* getDatabase(element);
            return database === undefined
              ? []
              : yield* loadDatabaseSchemas(element, database);
          }

          if (element.type === "schema") {
            if (element.connectionName === IN_MEMORY_CONNECTION) {
              const datasets = yield* datasources.getDatasets(
                element.notebookUri,
              );
              return Option.isSome(datasets)
                ? [...datasets.value.tables.values()].map((table) =>
                    tableItem(element, table, element.schemaPath),
                  )
                : [];
            }
            return yield* loadSchemaChildren(element);
          }

          return [];
        }),
      getTreeItem: (element: DatasourceTreeItem) =>
        Effect.succeed({
          id: itemId(element),
          label:
            element.type === "connection"
              ? element.displayName
              : element.type === "database"
                ? element.databaseName
                : element.type === "schema"
                  ? element.schemaName
                  : element.tableName,
          description:
            element.type === "connection" || element.type === "database"
              ? element.dialect
              : element.type === "table" && element.numRows !== null
                ? `${element.numRows} rows`
                : undefined,
          tooltip:
            element.type === "connection"
              ? `${element.displayName} (${element.dialect})`
              : element.type === "database"
                ? `${element.databaseName} (${element.dialect})`
                : element.type === "schema"
                  ? element.schemaPath.join(".")
                  : `${element.tableName} (${element.tableType})${element.numRows !== null ? `\n${element.numRows} rows` : ""}${element.numColumns !== null ? `, ${element.numColumns} columns` : ""}`,
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

    yield* Effect.forkScoped(
      editors.streamActiveNotebookChanges.pipe(
        Stream.runForEach(() => provider.refresh()),
      ),
    );
    yield* Effect.forkScoped(
      datasources.streamConnectionsChanges.pipe(
        Stream.runForEach(() => provider.refresh()),
      ),
    );
    yield* Effect.forkScoped(
      datasources.streamDatasetsChanges.pipe(
        Stream.runForEach(() => provider.refresh()),
      ),
    );

    yield* Effect.logDebug("Datasources view initialized");
  }),
);
