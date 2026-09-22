import {
  Context,
  Data,
  Deferred,
  Effect,
  Fiber,
  HashMap,
  Layer,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import * as MarimoClient from "../../lsp/MarimoClient.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
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

export interface Schema {
  readonly name: string;
  readonly tables: ReadonlyMap<string, DataTable>;
  readonly tablesResolved: boolean;
  readonly childSchemas: ReadonlyMap<string, Schema>;
  readonly childSchemasResolved: boolean;
}

export interface Database {
  readonly name: string;
  readonly dialect: string;
  readonly engine: string | null;
  readonly schemas: ReadonlyMap<string, Schema>;
  readonly schemasResolved: boolean;
}

export interface Connection extends Omit<DataSourceConnection, "databases"> {
  readonly databases: ReadonlyMap<string, Database>;
}

export interface ConnectionMap {
  // connection name -> connection data
  readonly connections: ReadonlyMap<string, Connection>;
}

export interface Datasets {
  // table name -> table data
  tables: Map<string, DataTable>;
  clear_channel: ("catalog" | "connection" | "duckdb" | "local") | null;
}

export class ExpansionError extends Data.TaggedError(
  "NotebookDatasources.ExpansionError",
)<{ readonly message: string }> {}

export interface Interface {
  readonly updateConnections: (
    session: NotebookDocumentSessions.Session,
    kernelSessionId: KernelSessionId,
    operation: DataSourceConnectionsNotification,
  ) => Effect.Effect<void>;
  readonly updateSchemaList: (
    session: NotebookDocumentSessions.Session,
    kernelSessionId: KernelSessionId,
    operation: SqlSchemaListPreviewNotification,
  ) => Effect.Effect<void>;
  readonly updateTableList: (
    session: NotebookDocumentSessions.Session,
    kernelSessionId: KernelSessionId,
    operation: SqlTableListPreviewNotification,
  ) => Effect.Effect<void>;
  readonly loadSchemas: (
    session: NotebookDocumentSessions.Session,
    connection: string,
    database: string,
    schemaPath: readonly string[],
  ) => Effect.Effect<void, ExpansionError>;
  readonly loadTables: (
    session: NotebookDocumentSessions.Session,
    connection: string,
    database: string,
    schema: string,
    schemaPath: readonly string[],
  ) => Effect.Effect<void, ExpansionError>;
  readonly updateDatasets: (
    session: NotebookDocumentSessions.Session,
    kernelSessionId: KernelSessionId,
    operation: DatasetsNotification,
  ) => Effect.Effect<void>;
  readonly getConnections: (
    notebookUri: NotebookId,
  ) => Effect.Effect<Option.Option<ConnectionMap>>;
  readonly getDatasets: (
    notebookUri: NotebookId,
  ) => Effect.Effect<Option.Option<Datasets>>;
  readonly clearKernelSession: (
    notebookUri: NotebookId,
    kernelSessionId: KernelSessionId,
  ) => Effect.Effect<void>;
  readonly streamConnectionsChanges: Stream.Stream<
    HashMap.HashMap<NotebookId, ConnectionMap>
  >;
  readonly streamDatasetsChanges: Stream.Stream<
    HashMap.HashMap<NotebookId, Datasets>
  >;
}

interface PendingExpansion {
  readonly session: NotebookDocumentSessions.Session;
  readonly kernelSessionId: KernelSessionId;
  readonly deferred: Deferred.Deferred<void, ExpansionError>;
  readonly fiber: Fiber.Fiber<void, ExpansionError>;
}

type DatasourceStateKey = readonly [
  notebookId: NotebookId,
  documentSessionId: NotebookDocumentSessions.Session["id"],
];

interface DatasourceState {
  readonly kernelSessionId: KernelSessionId;
  readonly connections: Option.Option<ConnectionMap>;
  readonly datasets: Option.Option<Datasets>;
}

const keyFor = (
  session: NotebookDocumentSessions.Session,
): DatasourceStateKey => [session.notebookId, session.id];

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
export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookDatasources",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const marimo = yield* MarimoClient.Service;
    const documentSessions = yield* NotebookDocumentSessions.Service;

    // One state entry per exact document opening. Kernel identity remains in
    // the value because a kernel can restart without reopening the document.
    const stateRef = yield* SubscriptionRef.make(
      HashMap.empty<DatasourceStateKey, DatasourceState>(),
    );
    const pendingByLocation = new Map<string, PendingExpansion>();
    const pendingByRequest = new Map<string, PendingExpansion>();
    const registeredSessionCleanups =
      new WeakSet<NotebookDocumentSessions.Session>();

    const releaseSession = Effect.fn("NotebookDatasources.releaseSession")(
      function* (session: NotebookDocumentSessions.Session) {
        const notebookUri = session.notebookId;
        registeredSessionCleanups.delete(session);
        for (const pending of [...pendingByRequest.values()]) {
          if (pending.session === session) {
            yield* Deferred.fail(
              pending.deferred,
              new ExpansionError({
                message: "Notebook closed",
              }),
            );
            yield* Fiber.await(pending.fiber);
          }
        }
        yield* SubscriptionRef.update(
          stateRef,
          HashMap.remove(keyFor(session)),
        );

        yield* Effect.logTrace("Released datasource data").pipe(
          Effect.annotateLogs({ notebookUri }),
        );
      },
    );

    const registerSessionCleanup = Effect.fn(
      "NotebookDatasources.registerSessionCleanup",
    )(function* (session: NotebookDocumentSessions.Session) {
      if (registeredSessionCleanups.has(session)) return;
      registeredSessionCleanups.add(session);
      yield* Scope.addFinalizer(session.scope, releaseSession(session));
    });

    const expansionKey = (
      notebookUri: NotebookId,
      connection: string,
      database: string,
      kind: "schemas" | "tables",
      schemaPath: readonly string[],
    ) => JSON.stringify([notebookUri, connection, database, kind, schemaPath]);

    const requestExpansionWork = Effect.fn(
      "NotebookDatasources.requestExpansionWork",
    )(function* <E>(
      session: NotebookDocumentSessions.Session,
      location: string,
      send: (
        requestId: string,
        kernelSessionId: KernelSessionId,
      ) => Effect.Effect<void, E>,
    ) {
      const state = HashMap.get(
        yield* SubscriptionRef.get(stateRef),
        keyFor(session),
      );
      if (Option.isNone(state) || Option.isNone(state.value.connections)) {
        return yield* new ExpansionError({
          message: "Datasource state is no longer active",
        });
      }
      const kernelSessionId = state.value.kernelSessionId;
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
          new ExpansionError({
            message: "Datasource expansion superseded",
          }),
        );
        yield* Fiber.await(current.fiber);
      }

      const requestId = crypto.randomUUID();
      const deferred = yield* Deferred.make<void, ExpansionError>();
      const fiber = yield* Deferred.await(deferred).pipe(
        Effect.timeoutOrElse({
          duration: EXPANSION_TIMEOUT,
          orElse: () =>
            Effect.fail(
              new ExpansionError({
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
        Effect.forkChild,
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
            new ExpansionError({ message: String(cause) }),
          ),
        ),
      );

      return yield* Fiber.join(fiber);
    });

    const requestExpansion = Effect.fn("NotebookDatasources.requestExpansion")(
      function* <E>(
        session: NotebookDocumentSessions.Session,
        location: string,
        send: (
          requestId: string,
          kernelSessionId: KernelSessionId,
        ) => Effect.Effect<void, E>,
      ) {
        const fiber = yield* requestExpansionWork(session, location, send).pipe(
          Effect.forkIn(session.scope),
        );
        return yield* Fiber.join(fiber);
      },
    );

    const completeExpansion = (requestId: string, error?: string | null) => {
      const pending = pendingByRequest.get(requestId);
      if (pending === undefined) return Effect.void;
      return Effect.gen(function* () {
        yield* error == null
          ? Deferred.succeed(pending.deferred, undefined)
          : Deferred.fail(
              pending.deferred,
              new ExpansionError({ message: error }),
            );
        yield* Fiber.await(pending.fiber);
      });
    };

    const isPendingExpansion = (
      session: NotebookDocumentSessions.Session,
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

    const convertSchemaToMap = (schema: DatabaseSchema): Schema => ({
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
      schemas: ReadonlyMap<string, Schema>,
      path: readonly string[],
      update: (schema: Schema) => Schema,
    ): ReadonlyMap<string, Schema> => {
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
      state: ConnectionMap,
      connectionName: string,
      databaseName: string,
      update: (database: Database) => Database,
    ): ConnectionMap => {
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
    ): ConnectionMap => {
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
    ): Datasets => {
      const tablesMap = new Map();

      for (const table of operation.tables) {
        tablesMap.set(table.name, table);
      }

      return {
        tables: tablesMap,
        clear_channel: operation.clear_channel ?? null,
      };
    };

    const getCurrentState = (
      state: HashMap.HashMap<DatasourceStateKey, DatasourceState>,
      notebookUri: NotebookId,
    ) =>
      Option.flatMap(documentSessions.current(notebookUri), (session) =>
        HashMap.get(state, keyFor(session)),
      );

    const projectCurrent = <A>(
      state: HashMap.HashMap<DatasourceStateKey, DatasourceState>,
      select: (state: DatasourceState) => Option.Option<A>,
    ) => {
      let projection = HashMap.empty<NotebookId, A>();
      for (const [[notebookId, documentSessionId], value] of state) {
        if (
          Option.exists(
            documentSessions.current(notebookId),
            (session) => session.id === documentSessionId,
          )
        ) {
          projection = Option.match(select(value), {
            onNone: () => projection,
            onSome: (selected) => HashMap.set(projection, notebookId, selected),
          });
        }
      }
      return projection;
    };

    const updateConnections = Effect.fn(
      "NotebookDatasources.updateConnections",
    )(function* (
      session: NotebookDocumentSessions.Session,
      kernelSessionId: KernelSessionId,
      operation: DataSourceConnectionsNotification,
    ) {
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const notebookUri = session.notebookId;
          const connectionsMap = convertConnectionsToMap(operation);
          const key = keyFor(session);

          yield* SubscriptionRef.update(stateRef, (map) => {
            const current = Option.filter(
              HashMap.get(map, key),
              (state) => state.kernelSessionId === kernelSessionId,
            );
            return HashMap.set(map, key, {
              kernelSessionId,
              connections: Option.some(connectionsMap),
              datasets: Option.flatMap(current, (state) => state.datasets),
            });
          });

          // Adding a finalizer to an already-closed scope runs it
          // immediately, so late writes cannot repopulate state.
          yield* registerSessionCleanup(session);

          yield* Effect.logTrace("Updated data source connections").pipe(
            Effect.annotateLogs({
              notebookUri,
              count: operation.connections.length,
            }),
          );
        }),
      );
    });

    const updateSchemaList = Effect.fn("NotebookDatasources.updateSchemaList")(
      function* (
        session: NotebookDocumentSessions.Session,
        kernelSessionId: KernelSessionId,
        operation: SqlSchemaListPreviewNotification,
      ) {
        yield* Effect.gen(function* () {
          const notebookUri = session.notebookId;
          if (
            !isPendingExpansion(session, kernelSessionId, operation.request_id)
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
            yield* Effect.logWarning("Failed to list datasource schemas").pipe(
              Effect.annotateLogs({
                notebookUri,
                requestId: operation.request_id,
                error: operation.error,
              }),
            );
            return;
          }

          yield* SubscriptionRef.update(stateRef, (notebooks) => {
            const key = keyFor(session);
            const current = HashMap.get(notebooks, key);
            if (
              Option.isNone(current) ||
              current.value.kernelSessionId !== kernelSessionId ||
              Option.isNone(current.value.connections)
            ) {
              return notebooks;
            }
            const { connection, database } = operation.metadata;
            const schemaPath = operation.metadata.schema_path ?? [];
            const schemas = convertSchemasToMap(operation.schemas ?? []);
            const next = updateDatabase(
              current.value.connections.value,
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
            return next === current.value.connections.value
              ? notebooks
              : HashMap.set(notebooks, key, {
                  ...current.value,
                  connections: Option.some(next),
                });
          });
          yield* completeExpansion(operation.request_id);
        });
      },
    );

    const updateTableList = Effect.fn("NotebookDatasources.updateTableList")(
      function* (
        session: NotebookDocumentSessions.Session,
        kernelSessionId: KernelSessionId,
        operation: SqlTableListPreviewNotification,
      ) {
        yield* Effect.gen(function* () {
          const notebookUri = session.notebookId;
          if (
            !isPendingExpansion(session, kernelSessionId, operation.request_id)
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

          yield* SubscriptionRef.update(stateRef, (notebooks) => {
            const key = keyFor(session);
            const current = HashMap.get(notebooks, key);
            if (
              Option.isNone(current) ||
              current.value.kernelSessionId !== kernelSessionId ||
              Option.isNone(current.value.connections)
            ) {
              return notebooks;
            }
            const { connection, database, schema } = operation.metadata;
            const schemaPath = operation.metadata.schema_path ?? [];
            const path = schemaPath.length > 0 ? schemaPath : [schema];
            const tables = convertTablesToMap(operation.tables ?? []);
            const next = updateDatabase(
              current.value.connections.value,
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
            return next === current.value.connections.value
              ? notebooks
              : HashMap.set(notebooks, key, {
                  ...current.value,
                  connections: Option.some(next),
                });
          });
          yield* completeExpansion(operation.request_id);
        });
      },
    );

    const loadSchemas = Effect.fn("NotebookDatasources.loadSchemas")(function* (
      session: NotebookDocumentSessions.Session,
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
      yield* requestExpansion(session, location, (requestId, kernelSessionId) =>
        marimo.listSqlSchemas({
          notebookUri,
          kernelSessionId,
          requestId,
          engine: connection,
          database,
          schemaPath: [...schemaPath],
        }),
      );
    });

    const loadTables = Effect.fn("NotebookDatasources.loadTables")(function* (
      session: NotebookDocumentSessions.Session,
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
      yield* requestExpansion(session, location, (requestId, kernelSessionId) =>
        marimo.listSqlTables({
          notebookUri,
          kernelSessionId,
          requestId,
          engine: connection,
          database,
          schema,
          schemaPath: [...schemaPath],
        }),
      );
    });

    const updateDatasets = Effect.fn("NotebookDatasources.updateDatasets")(
      function* (
        session: NotebookDocumentSessions.Session,
        kernelSessionId: KernelSessionId,
        operation: DatasetsNotification,
      ) {
        yield* Effect.uninterruptible(
          Effect.gen(function* () {
            const notebookUri = session.notebookId;
            const datasetsMap = convertDatasetsToMap(operation);
            const key = keyFor(session);

            yield* SubscriptionRef.update(stateRef, (map) => {
              const current = Option.filter(
                HashMap.get(map, key),
                (state) => state.kernelSessionId === kernelSessionId,
              );
              return HashMap.set(map, key, {
                kernelSessionId,
                connections: Option.flatMap(
                  current,
                  (state) => state.connections,
                ),
                datasets: Option.some(datasetsMap),
              });
            });

            yield* registerSessionCleanup(session);

            yield* Effect.logTrace("Updated datasets").pipe(
              Effect.annotateLogs({
                notebookUri,
                count: operation.tables.length,
                clear_channel: operation.clear_channel,
              }),
            );
          }),
        );
      },
    );

    const getConnections = Effect.fn("NotebookDatasources.getConnections")(
      function* (notebookUri: NotebookId) {
        const state = yield* SubscriptionRef.get(stateRef);
        return getCurrentState(state, notebookUri).pipe(
          Option.flatMap((current) => current.connections),
        );
      },
    );

    const getDatasets = Effect.fn("NotebookDatasources.getDatasets")(function* (
      notebookUri: NotebookId,
    ) {
      const state = yield* SubscriptionRef.get(stateRef);
      return getCurrentState(state, notebookUri).pipe(
        Option.flatMap((current) => current.datasets),
      );
    });

    const clearKernelSession = Effect.fn(
      "NotebookDatasources.clearKernelSession",
    )(function* (notebookUri: NotebookId, kernelSessionId: KernelSessionId) {
      for (const pending of [...pendingByRequest.values()]) {
        if (
          pending.session.notebookId === notebookUri &&
          pending.kernelSessionId === kernelSessionId
        ) {
          yield* Deferred.fail(
            pending.deferred,
            new ExpansionError({
              message: "Kernel session ended",
            }),
          );
          yield* Fiber.await(pending.fiber);
        }
      }
      yield* SubscriptionRef.update(
        stateRef,
        HashMap.filter(
          (state, [stateNotebookUri]) =>
            stateNotebookUri !== notebookUri ||
            state.kernelSessionId !== kernelSessionId,
        ),
      );
    });

    return Service.of({
      updateConnections,
      updateSchemaList,
      updateTableList,
      loadSchemas,
      loadTables,
      updateDatasets,
      getConnections,
      getDatasets,
      clearKernelSession,

      /**
       * Stream of data source connection changes.
       *
       * Emits the current value on subscription, then all subsequent changes.
       */
      streamConnectionsChanges: SubscriptionRef.changes(stateRef).pipe(
        Stream.map((state) =>
          projectCurrent(state, (current) => current.connections),
        ),
        Stream.changes,
      ),

      /**
       * Stream of dataset changes.
       *
       * Emits the current value on subscription, then all subsequent changes.
       */
      streamDatasetsChanges: SubscriptionRef.changes(stateRef).pipe(
        Stream.map((state) =>
          projectCurrent(state, (current) => current.datasets),
        ),
        Stream.changes,
      ),
    });
  }),
);

export const defaultLayer = layer.pipe(
  Layer.provide(NotebookDocumentSessions.layer),
);
