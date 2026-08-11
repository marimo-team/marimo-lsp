import { assert, expect, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, TestClock } from "effect";

import { makeTestMarimoClient } from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { notebookId, requestId } from "../../../lib/__tests__/branded.ts";
import type {
  DataSourceConnectionsNotification,
  DatabaseSchema,
  DataTable,
  SqlSchemaListPreviewNotification,
  SqlTableListPreviewNotification,
} from "../../../types.ts";
import type { MarimoApiCall } from "../../../types.ts";
import { DatasourcesService } from "../DatasourcesService.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");

const makeLayer = (
  execute: (request: MarimoApiCall) => Effect.Effect<unknown> = () =>
    Effect.succeed(null),
) =>
  Layer.empty.pipe(
    Layer.provideMerge(DatasourcesService.Default),
    Layer.provide(makeTestMarimoClient({ execute })),
  );

const makeRecordingLayer = () => {
  const calls: MarimoApiCall[] = [];
  return {
    calls,
    layer: makeLayer((request) => {
      calls.push(request);
      return Effect.succeed(null);
    }),
  };
};

const table = (name: string): DataTable => ({
  name,
  source: "warehouse",
  source_type: "connection",
  num_rows: null,
  num_columns: null,
  variable_name: null,
  columns: [],
});

const schema = (
  name: string,
  options: Partial<DatabaseSchema> = {},
): DatabaseSchema => ({
  name,
  tables: [],
  ...options,
});

const connections = (
  schemas: DatabaseSchema[],
  schemasResolved = true,
): DataSourceConnectionsNotification => ({
  op: "data-source-connections",
  connections: [
    {
      name: "warehouse",
      source: "postgres",
      dialect: "postgres",
      display_name: "Warehouse",
      databases: [
        {
          name: "analytics",
          dialect: "postgres",
          schemas,
          schemas_resolved: schemasResolved,
        },
      ],
    },
  ],
});

const getDatabase = Effect.fn(function* () {
  const service = yield* DatasourcesService;
  const state = yield* service.getConnections(NOTEBOOK_URI);
  assert(Option.isSome(state));
  const database = state.value.connections
    .get("warehouse")
    ?.databases.get("analytics");
  assert(database !== undefined);
  return database;
});

it.effect("preserves recursive schemas and deferred discovery", () =>
  Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections(
        [
          schema("catalog", {
            tables_resolved: false,
            child_schemas_resolved: false,
            child_schemas: [schema("loaded", { tables: [table("events")] })],
          }),
        ],
        false,
      ),
    );

    const database = yield* getDatabase();
    const catalog = database.schemas.get("catalog");
    assert(catalog !== undefined);
    expect(database.schemasResolved).toBe(false);
    expect(catalog.tablesResolved).toBe(false);
    expect(catalog.childSchemasResolved).toBe(false);
    expect(catalog.childSchemas.get("loaded")?.tables.has("events")).toBe(true);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("merges child schemas at their parent path", () => {
  const { calls, layer } = makeRecordingLayer();
  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections([
        schema("catalog", {
          tables: [table("existing")],
          child_schemas_resolved: false,
        }),
      ]),
    );

    const load = yield* Effect.fork(
      service.loadSchemas(NOTEBOOK_URI, "warehouse", "analytics", ["catalog"]),
    );
    yield* Effect.yieldNow;
    const call = calls[0];
    assert(call?.method === "list-sql-schemas");

    const operation: SqlSchemaListPreviewNotification = {
      op: "sql-schema-list-preview",
      request_id: requestId(call.params.inner.requestId),
      metadata: {
        connection: "warehouse",
        database: "analytics",
        schema_path: ["catalog"],
      },
      schemas: [schema("events", { tables_resolved: false })],
    };
    yield* service.updateSchemaList(NOTEBOOK_URI, operation);
    yield* Fiber.join(load);

    const catalog = (yield* getDatabase()).schemas.get("catalog");
    assert(catalog !== undefined);
    expect(catalog.childSchemasResolved).toBe(true);
    expect(catalog.childSchemas.get("events")?.tablesResolved).toBe(false);
    expect(catalog.tables.has("existing")).toBe(true);
  }).pipe(Effect.provide(layer));
});

it.effect("merges tables at a nested schema path", () => {
  const { calls, layer } = makeRecordingLayer();
  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections([
        schema("catalog", {
          child_schemas: [schema("events", { tables_resolved: false })],
        }),
      ]),
    );

    const load = yield* Effect.fork(
      service.loadTables(NOTEBOOK_URI, "warehouse", "analytics", "events", [
        "catalog",
        "events",
      ]),
    );
    yield* Effect.yieldNow;
    const call = calls[0];
    assert(call?.method === "list-sql-tables");

    const operation: SqlTableListPreviewNotification = {
      op: "sql-table-list-preview",
      request_id: requestId(call.params.inner.requestId),
      metadata: {
        type: "sql-metadata",
        connection: "warehouse",
        database: "analytics",
        schema: "events",
        schema_path: ["catalog", "events"],
      },
      tables: [table("clicks")],
    };
    yield* service.updateTableList(NOTEBOOK_URI, operation);
    yield* Fiber.join(load);

    const events = (yield* getDatabase()).schemas
      .get("catalog")
      ?.childSchemas.get("events");
    expect(events?.tablesResolved).toBe(true);
    expect(events?.tables.has("clicks")).toBe(true);
  }).pipe(Effect.provide(layer));
});

it.effect("does not resolve deferred state after an error", () => {
  const { calls, layer } = makeRecordingLayer();
  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections([schema("public", { tables_resolved: false })]),
    );

    const load = yield* Effect.fork(
      Effect.result(
        service.loadTables(NOTEBOOK_URI, "warehouse", "analytics", "public", [
          "public",
        ]),
      ),
    );
    yield* Effect.yieldNow;
    const call = calls[0];
    assert(call?.method === "list-sql-tables");

    yield* service.updateTableList(NOTEBOOK_URI, {
      op: "sql-table-list-preview",
      request_id: requestId(call.params.inner.requestId),
      metadata: {
        type: "sql-metadata",
        connection: "warehouse",
        database: "analytics",
        schema: "public",
      },
      tables: [],
      error: "connection lost",
    });
    expect((yield* Fiber.join(load))._tag).toBe("Left");

    expect((yield* getDatabase()).schemas.get("public")?.tablesResolved).toBe(
      false,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("ignores uncorrelated expansion responses", () =>
  Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections([schema("public", { tables_resolved: false })], false),
    );

    yield* service.updateSchemaList(NOTEBOOK_URI, {
      op: "sql-schema-list-preview",
      request_id: requestId("stale-schemas"),
      metadata: { connection: "warehouse", database: "analytics" },
      schemas: [schema("stale")],
    });
    yield* service.updateTableList(NOTEBOOK_URI, {
      op: "sql-table-list-preview",
      request_id: requestId("stale-tables"),
      metadata: {
        type: "sql-metadata",
        connection: "warehouse",
        database: "analytics",
        schema: "public",
      },
      tables: [table("stale")],
    });

    const database = yield* getDatabase();
    expect(database.schemasResolved).toBe(false);
    expect(database.schemas.has("stale")).toBe(false);
    expect(database.schemas.get("public")?.tablesResolved).toBe(false);
    expect(database.schemas.get("public")?.tables.has("stale")).toBe(false);
  }).pipe(Effect.provide(makeLayer())),
);

it.effect("deduplicates concurrent schema expansion requests", () => {
  const calls: MarimoApiCall[] = [];
  const layer = makeLayer((request) => {
    calls.push(request);
    return Effect.succeed(null);
  });

  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(NOTEBOOK_URI, connections([], false));

    const first = yield* Effect.fork(
      service.loadSchemas(NOTEBOOK_URI, "warehouse", "analytics", []),
    );
    const second = yield* Effect.fork(
      service.loadSchemas(NOTEBOOK_URI, "warehouse", "analytics", []),
    );
    yield* Effect.yieldNow;

    expect(calls).toHaveLength(1);
    const call = calls[0];
    assert(call?.method === "list-sql-schemas");
    yield* service.updateSchemaList(NOTEBOOK_URI, {
      op: "sql-schema-list-preview",
      request_id: requestId(call.params.inner.requestId),
      metadata: {
        connection: "warehouse",
        database: "analytics",
      },
      schemas: [schema("public")],
    });

    yield* Fiber.join(first);
    yield* Fiber.join(second);
    const database = yield* getDatabase();
    expect(database.schemasResolved).toBe(true);
    expect(database.schemas.has("public")).toBe(true);
  }).pipe(Effect.provide(layer));
});

it.effect("retries nested table expansion after an error", () => {
  const calls: MarimoApiCall[] = [];
  const layer = makeLayer((request) => {
    calls.push(request);
    return Effect.succeed(null);
  });

  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections([
        schema("catalog", {
          child_schemas: [schema("events", { tables_resolved: false })],
        }),
      ]),
    );

    const first = yield* Effect.fork(
      Effect.result(
        service.loadTables(NOTEBOOK_URI, "warehouse", "analytics", "events", [
          "catalog",
          "events",
        ]),
      ),
    );
    yield* Effect.yieldNow;

    const call = calls[0];
    assert(call?.method === "list-sql-tables");
    expect(call.params.inner).toMatchObject({
      engine: "warehouse",
      database: "analytics",
      schema: "events",
      schemaPath: ["catalog", "events"],
    });
    yield* service.updateTableList(NOTEBOOK_URI, {
      op: "sql-table-list-preview",
      request_id: requestId(call.params.inner.requestId),
      metadata: {
        type: "sql-metadata",
        connection: "warehouse",
        database: "analytics",
        schema: "events",
        schema_path: ["catalog", "events"],
      },
      tables: [],
      error: "connection lost",
    });
    expect((yield* Fiber.join(first))._tag).toBe("Left");

    const retry = yield* Effect.fork(
      service.loadTables(NOTEBOOK_URI, "warehouse", "analytics", "events", [
        "catalog",
        "events",
      ]),
    );
    yield* Effect.yieldNow;
    expect(calls).toHaveLength(2);
    yield* Fiber.interrupt(retry);
  }).pipe(Effect.provide(layer));
});

it.effect("shares one timeout deadline and retries after it expires", () => {
  const calls: MarimoApiCall[] = [];
  const layer = makeLayer((request) => {
    calls.push(request);
    return Effect.succeed(null);
  });

  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(NOTEBOOK_URI, connections([], false));

    const first = yield* Effect.fork(
      Effect.result(
        service.loadSchemas(NOTEBOOK_URI, "warehouse", "analytics", []),
      ),
    );
    yield* Effect.yieldNow;
    expect(calls).toHaveLength(1);

    yield* TestClock.adjust("20 seconds");
    const joined = yield* Effect.fork(
      Effect.result(
        service.loadSchemas(NOTEBOOK_URI, "warehouse", "analytics", []),
      ),
    );
    yield* Effect.yieldNow;
    expect(calls).toHaveLength(1);

    yield* TestClock.adjust("10 seconds");
    expect((yield* Fiber.join(first))._tag).toBe("Left");
    expect((yield* Fiber.join(joined))._tag).toBe("Left");

    const retry = yield* Effect.fork(
      service.loadSchemas(NOTEBOOK_URI, "warehouse", "analytics", []),
    );
    yield* Effect.yieldNow;
    expect(calls).toHaveLength(2);
    yield* Fiber.interrupt(retry);
  }).pipe(Effect.provide(layer));
});
