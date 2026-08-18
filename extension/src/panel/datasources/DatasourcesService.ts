import {
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  HashMap,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";

import { MarimoClient } from "../../lsp/MarimoClient.ts";
import type { NotebookDocumentSession } from "../../notebook/NotebookDocumentSessions.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { KernelSessionId } from "../../schemas/Models.gen.ts";
import type {
  DataSourceConnection,
  DataSourceConnectionsNotification,
  DatabaseSchema,
  DataTable,
  DatasetsNotification,
  SqlSchemaListPreviewNotification,
  SqlTableListPreviewNotification,
} from "../../types.ts";

/**
 * Maps for efficient lookups in the datasource hierarchy:
 * Connection -> Database -> recursive Schema -> Table
 */

export interface DatasourceSchema {
  readonly name: string;
  readonly tables: ReadonlyMap<string, DataTable>;
  readonly tablesResolved: boolean;
  readonly childSchemas: ReadonlyMap<string, DatasourceSchema>;
  readonly childSchemasResolved: boolean;
}

export interface DatasourceDatabase {
  readonly name: string;
  readonly dialect: string;
  readonly engine: string | null;
  readonly schemas: ReadonlyMap<string, DatasourceSchema>;
  readonly schemasResolved: boolean;
}

export interface DatasourceConnection extends Omit<
  DataSourceConnection,
  "databases"
> {
  readonly databases: ReadonlyMap<string, DatasourceDatabase>;
}

export interface DataSourceConnectionMap {
  // connection name -> connection data
  readonly connections: ReadonlyMap<string, DatasourceConnection>;
}

interface DatasetsMap {
  // table name -> table data
  tables: Map<string, DataTable>;
  clear_channel: ("catalog" | "connection" | "duckdb" | "local") | null;
}

export class DatasourceExpansionError extends Data.TaggedError(
  "DatasourceExpansionError",
)<{ readonly message: string }> {}

interface PendingExpansion {
  readonly session: NotebookDocumentSession;
  readonly kernelSessionId: KernelSessionId;
  readonly deferred: Deferred.Deferred<void, DatasourceExpansionError>;
  readonly fiber: Fiber.Fiber<void, DatasourceExpansionError>;
}

interface Owned<A> {
  readonly documentSessionId: NotebookDocumentSession["id"];
  readonly kernelSessionId: KernelSessionId;
  readonly value: A;
}

const EXPANSION_TIMEOUT = "30 seconds";

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
export class DatasourcesService extends Context.Service<DatasourcesService>()(
  "DatasourcesService",
  {
    make: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const serviceScope = yield* Effect.scope;

      // Track data source connections: NotebookUri -> DataSourceConnectionMap
      const connectionsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, Owned<DataSourceConnectionMap>>(),
      );

      // Track datasets: NotebookUri -> DatasetsMap
      const datasetsRef = yield* SubscriptionRef.make(
        HashMap.empty<NotebookId, Owned<DatasetsMap>>(),
      );
      const pendingByLocation = new Map<string, PendingExpansion>();
      const pendingByRequest = new Map<string, PendingExpansion>();

      const expansionKey = (
        notebookUri: NotebookId,
        connection: string,
        database: string,
        kind: "schemas" | "tables",
        schemaPath: readonly string[],
      ) =>
        JSON.stringify([notebookUri, connection, database, kind, schemaPath]);

      const requestExpansion = Effect.fn(function* (
        session: NotebookDocumentSession,
        location: string,
        send: (
          requestId: string,
          kernelSessionId: KernelSessionId,
        ) => Effect.Effect<void, unknown>,
      ) {
        const connections = HashMap.get(
          yield* SubscriptionRef.get(connectionsRef),
          session.notebookId,
        );
        if (
          Option.isNone(connections) ||
          connections.value.documentSessionId !== session.id
        ) {
          return yield* new DatasourceExpansionError({
            message: "Datasource state is no longer active",
          });
        }
        const kernelSessionId = connections.value.kernelSessionId;
        const current = pendingByLocation.get(location);
        if (
          current?.session === session &&
          current.kernelSessionId === kernelSessionId
        ) {
          return yield* Fiber.join(current.fiber);
        }
        if (current !== undefined) {
          yield* Deferred.fail(
            current.deferred,
            new DatasourceExpansionError({
              message: "Datasource expansion superseded",
            }),
          );
          yield* Fiber.await(current.fiber);
        }

        const requestId = crypto.randomUUID();
        const deferred = yield* Deferred.make<void, DatasourceExpansionError>();
        const fiber = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOrElse({
            duration: EXPANSION_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new DatasourceExpansionError({
                  message: "Timed out while loading datasource metadata",
                }),
              ),
          }),
          Effect.ensuring(
            Effect.sync(() => {
              const completed = pendingByRequest.get(requestId);
              if (completed?.deferred !== deferred) return;
              pendingByRequest.delete(requestId);
              if (pendingByLocation.get(location) === completed) {
                pendingByLocation.delete(location);
              }
            }),
          ),
          Effect.forkIn(serviceScope),
        );
        const pending = {
          session,
          kernelSessionId,
          deferred,
          fiber,
        };
        pendingByLocation.set(location, pending);
        pendingByRequest.set(requestId, pending);

        yield* send(requestId, kernelSessionId).pipe(
          Effect.catch((cause) =>
            Deferred.fail(
              deferred,
              new DatasourceExpansionError({ message: String(cause) }),
            ),
          ),
        );

        return yield* Fiber.join(fiber);
      });

      const completeExpansion = (requestId: string, error?: string | null) => {
        const pending = pendingByRequest.get(requestId);
        if (pending === undefined) return Effect.void;
        return Effect.gen(function* () {
          yield* error == null
            ? Deferred.succeed(pending.deferred, undefined)
            : Deferred.fail(
                pending.deferred,
                new DatasourceExpansionError({ message: error }),
              );
          yield* Fiber.await(pending.fiber);
        });
      };

      const isPendingExpansion = (
        session: NotebookDocumentSession,
        kernelSessionId: KernelSessionId,
        requestId: string,
      ) => {
        const pending = pendingByRequest.get(requestId);
        return (
          pending?.session === session &&
          pending.kernelSessionId === kernelSessionId
        );
      };

      const convertTablesToMap = (tables: readonly DataTable[]) =>
        new Map(tables.map((table) => [table.name, table]));

      const convertSchemaToMap = (
        schema: DatabaseSchema,
      ): DatasourceSchema => ({
        name: schema.name,
        tables: convertTablesToMap(schema.tables),
        tablesResolved: schema.tables_resolved ?? true,
        childSchemas: new Map(
          (schema.child_schemas ?? []).map((child) => [
            child.name,
            convertSchemaToMap(child),
          ]),
        ),
        childSchemasResolved: schema.child_schemas_resolved ?? true,
      });

      const convertSchemasToMap = (schemas: readonly DatabaseSchema[]) =>
        new Map(
          schemas.map((schema) => [schema.name, convertSchemaToMap(schema)]),
        );

      const updateSchemaAtPath = (
        schemas: ReadonlyMap<string, DatasourceSchema>,
        path: readonly string[],
        update: (schema: DatasourceSchema) => DatasourceSchema,
      ): ReadonlyMap<string, DatasourceSchema> => {
        const [name, ...rest] = path;
        if (name === undefined) return schemas;
        const schema = schemas.get(name);
        if (schema === undefined) return schemas;

        const updated =
          rest.length === 0
            ? update(schema)
            : {
                ...schema,
                childSchemas: updateSchemaAtPath(
                  schema.childSchemas,
                  rest,
                  update,
                ),
              };
        return new Map(schemas).set(name, updated);
      };

      const updateDatabase = (
        state: DataSourceConnectionMap,
        connectionName: string,
        databaseName: string,
        update: (database: DatasourceDatabase) => DatasourceDatabase,
      ): DataSourceConnectionMap => {
        const connection = state.connections.get(connectionName);
        const database = connection?.databases.get(databaseName);
        if (connection === undefined || database === undefined) return state;

        const nextConnection = {
          ...connection,
          databases: new Map(connection.databases).set(
            databaseName,
            update(database),
          ),
        };
        return {
          connections: new Map(state.connections).set(
            connectionName,
            nextConnection,
          ),
        };
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
              schemas: convertSchemasToMap(db.schemas),
              schemasResolved: db.schemas_resolved ?? true,
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
          session: NotebookDocumentSession,
          kernelSessionId: KernelSessionId,
          operation: DataSourceConnectionsNotification,
        ) {
          return Effect.gen(function* () {
            const notebookUri = session.notebookId;
            const connectionsMap = convertConnectionsToMap(operation);

            yield* SubscriptionRef.update(connectionsRef, (map) =>
              HashMap.set(map, notebookUri, {
                documentSessionId: session.id,
                kernelSessionId,
                value: connectionsMap,
              }),
            );
            yield* SubscriptionRef.update(datasetsRef, (map) => {
              const current = HashMap.get(map, notebookUri);
              return Option.isSome(current) &&
                (current.value.documentSessionId !== session.id ||
                  current.value.kernelSessionId !== kernelSessionId)
                ? HashMap.remove(map, notebookUri)
                : map;
            });

            yield* Effect.logTrace("Updated data source connections").pipe(
              Effect.annotateLogs({
                notebookUri,
                count: operation.connections.length,
              }),
            );
          });
        },

        updateSchemaList(
          session: NotebookDocumentSession,
          kernelSessionId: KernelSessionId,
          operation: SqlSchemaListPreviewNotification,
        ) {
          return Effect.gen(function* () {
            const notebookUri = session.notebookId;
            if (
              !isPendingExpansion(
                session,
                kernelSessionId,
                operation.request_id,
              )
            ) {
              yield* Effect.logTrace(
                "Ignored uncorrelated datasource schema response",
              ).pipe(
                Effect.annotateLogs({
                  notebookUri,
                  requestId: operation.request_id,
                }),
              );
              return;
            }

            if (operation.error != null) {
              yield* completeExpansion(operation.request_id, operation.error);
              yield* Effect.logWarning(
                "Failed to list datasource schemas",
              ).pipe(
                Effect.annotateLogs({
                  notebookUri,
                  requestId: operation.request_id,
                  error: operation.error,
                }),
              );
              return;
            }

            yield* SubscriptionRef.update(connectionsRef, (notebooks) => {
              const current = HashMap.get(notebooks, notebookUri);
              if (
                Option.isNone(current) ||
                current.value.documentSessionId !== session.id ||
                current.value.kernelSessionId !== kernelSessionId
              ) {
                return notebooks;
              }
              const { connection, database } = operation.metadata;
              const schemaPath = operation.metadata.schema_path ?? [];
              const schemas = convertSchemasToMap(operation.schemas ?? []);
              const next = updateDatabase(
                current.value.value,
                connection,
                database,
                (db) =>
                  schemaPath.length === 0
                    ? { ...db, schemas, schemasResolved: true }
                    : {
                        ...db,
                        schemas: updateSchemaAtPath(
                          db.schemas,
                          schemaPath,
                          (schema) => ({
                            ...schema,
                            childSchemas: schemas,
                            childSchemasResolved: true,
                          }),
                        ),
                      },
              );
              return next === current.value.value
                ? notebooks
                : HashMap.set(notebooks, notebookUri, {
                    documentSessionId: session.id,
                    kernelSessionId,
                    value: next,
                  });
            });
            yield* completeExpansion(operation.request_id);
          });
        },

        updateTableList(
          session: NotebookDocumentSession,
          kernelSessionId: KernelSessionId,
          operation: SqlTableListPreviewNotification,
        ) {
          return Effect.gen(function* () {
            const notebookUri = session.notebookId;
            if (
              !isPendingExpansion(
                session,
                kernelSessionId,
                operation.request_id,
              )
            ) {
              yield* Effect.logTrace(
                "Ignored uncorrelated datasource table response",
              ).pipe(
                Effect.annotateLogs({
                  notebookUri,
                  requestId: operation.request_id,
                }),
              );
              return;
            }

            if (operation.error != null) {
              yield* completeExpansion(operation.request_id, operation.error);
              yield* Effect.logWarning("Failed to list datasource tables").pipe(
                Effect.annotateLogs({
                  notebookUri,
                  requestId: operation.request_id,
                  error: operation.error,
                }),
              );
              return;
            }

            yield* SubscriptionRef.update(connectionsRef, (notebooks) => {
              const current = HashMap.get(notebooks, notebookUri);
              if (
                Option.isNone(current) ||
                current.value.documentSessionId !== session.id ||
                current.value.kernelSessionId !== kernelSessionId
              ) {
                return notebooks;
              }
              const { connection, database, schema } = operation.metadata;
              const schemaPath = operation.metadata.schema_path ?? [];
              const path = schemaPath.length > 0 ? schemaPath : [schema];
              const tables = convertTablesToMap(operation.tables ?? []);
              const next = updateDatabase(
                current.value.value,
                connection,
                database,
                (db) => ({
                  ...db,
                  schemas: updateSchemaAtPath(db.schemas, path, (current) => ({
                    ...current,
                    tables,
                    tablesResolved: true,
                  })),
                }),
              );
              return next === current.value.value
                ? notebooks
                : HashMap.set(notebooks, notebookUri, {
                    documentSessionId: session.id,
                    kernelSessionId,
                    value: next,
                  });
            });
            yield* completeExpansion(operation.request_id);
          });
        },

        loadSchemas(
          session: NotebookDocumentSession,
          connection: string,
          database: string,
          schemaPath: readonly string[],
        ) {
          const notebookUri = session.notebookId;
          const location = expansionKey(
            notebookUri,
            connection,
            database,
            "schemas",
            schemaPath,
          );
          return requestExpansion(
            session,
            location,
            (requestId, kernelSessionId) =>
              marimo.listSqlSchemas({
                notebookUri,
                sessionId: kernelSessionId,
                inner: {
                  requestId,
                  engine: connection,
                  database,
                  schemaPath: [...schemaPath],
                },
              }),
          );
        },

        loadTables(
          session: NotebookDocumentSession,
          connection: string,
          database: string,
          schema: string,
          schemaPath: readonly string[],
        ) {
          const notebookUri = session.notebookId;
          const location = expansionKey(
            notebookUri,
            connection,
            database,
            "tables",
            schemaPath,
          );
          return requestExpansion(
            session,
            location,
            (requestId, kernelSessionId) =>
              marimo.listSqlTables({
                notebookUri,
                sessionId: kernelSessionId,
                inner: {
                  requestId,
                  engine: connection,
                  database,
                  schema,
                  schemaPath: [...schemaPath],
                },
              }),
          );
        },

        /**
         * Update datasets for a notebook
         */
        updateDatasets(
          session: NotebookDocumentSession,
          kernelSessionId: KernelSessionId,
          operation: DatasetsNotification,
        ) {
          return Effect.gen(function* () {
            const notebookUri = session.notebookId;
            const datasetsMap = convertDatasetsToMap(operation);

            yield* SubscriptionRef.update(datasetsRef, (map) =>
              HashMap.set(map, notebookUri, {
                documentSessionId: session.id,
                kernelSessionId,
                value: datasetsMap,
              }),
            );
            yield* SubscriptionRef.update(connectionsRef, (map) => {
              const current = HashMap.get(map, notebookUri);
              return Option.isSome(current) &&
                (current.value.documentSessionId !== session.id ||
                  current.value.kernelSessionId !== kernelSessionId)
                ? HashMap.remove(map, notebookUri)
                : map;
            });

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
            return HashMap.get(map, notebookUri).pipe(
              Option.map((owned) => owned.value),
            );
          });
        },

        /**
         * Get datasets for a notebook
         */
        getDatasets(notebookUri: NotebookId) {
          return Effect.gen(function* () {
            const map = yield* SubscriptionRef.get(datasetsRef);
            return HashMap.get(map, notebookUri).pipe(
              Option.map((owned) => owned.value),
            );
          });
        },

        clearKernelSession(
          notebookUri: NotebookId,
          kernelSessionId: KernelSessionId,
        ) {
          return Effect.gen(function* () {
            for (const pending of [...pendingByRequest.values()]) {
              if (
                pending.session.notebookId === notebookUri &&
                pending.kernelSessionId === kernelSessionId
              ) {
                yield* Deferred.fail(
                  pending.deferred,
                  new DatasourceExpansionError({
                    message: "Kernel session ended",
                  }),
                );
                yield* Fiber.await(pending.fiber);
              }
            }
            yield* SubscriptionRef.update(connectionsRef, (map) => {
              const current = HashMap.get(map, notebookUri);
              return Option.isSome(current) &&
                current.value.kernelSessionId === kernelSessionId
                ? HashMap.remove(map, notebookUri)
                : map;
            });
            yield* SubscriptionRef.update(datasetsRef, (map) => {
              const current = HashMap.get(map, notebookUri);
              return Option.isSome(current) &&
                current.value.kernelSessionId === kernelSessionId
                ? HashMap.remove(map, notebookUri)
                : map;
            });
          });
        },

        /**
         * Clear all datasource data for a notebook
         */
        clearSession(session: NotebookDocumentSession) {
          return Effect.gen(function* () {
            const notebookUri = session.notebookId;
            for (const pending of pendingByRequest.values()) {
              if (pending.session === session) {
                yield* Deferred.fail(
                  pending.deferred,
                  new DatasourceExpansionError({
                    message: "Notebook closed",
                  }),
                );
                yield* Fiber.await(pending.fiber);
              }
            }
            yield* SubscriptionRef.update(connectionsRef, (map) => {
              const current = HashMap.get(map, notebookUri);
              return Option.isSome(current) &&
                current.value.documentSessionId === session.id
                ? HashMap.remove(map, notebookUri)
                : map;
            });
            yield* SubscriptionRef.update(datasetsRef, (map) => {
              const current = HashMap.get(map, notebookUri);
              return Option.isSome(current) &&
                current.value.documentSessionId === session.id
                ? HashMap.remove(map, notebookUri)
                : map;
            });

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
        streamConnectionsChanges: SubscriptionRef.changes(connectionsRef).pipe(
          Stream.map((notebooks) =>
            HashMap.map(notebooks, (owned) => owned.value),
          ),
        ),

        /**
         * Stream of dataset changes.
         *
         * Emits the current value on subscription, then all subsequent changes.
         */
        streamDatasetsChanges: SubscriptionRef.changes(datasetsRef).pipe(
          Stream.map((notebooks) =>
            HashMap.map(notebooks, (owned) => owned.value),
          ),
        ),
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
