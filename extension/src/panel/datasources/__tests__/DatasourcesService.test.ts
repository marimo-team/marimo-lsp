import { assert, expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";

import { notebookId, requestId } from "../../../lib/__tests__/branded.ts";
import type {
  DataSourceConnectionsNotification,
  DatabaseSchema,
  DataTable,
  SqlSchemaListPreviewNotification,
  SqlTableListPreviewNotification,
} from "../../../types.ts";
import { DatasourcesService } from "../DatasourcesService.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");

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
  }).pipe(Effect.provide(DatasourcesService.Default)),
);

it.effect("merges child schemas at their parent path", () =>
  Effect.gen(function* () {
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

    const operation: SqlSchemaListPreviewNotification = {
      op: "sql-schema-list-preview",
      request_id: requestId("schemas"),
      metadata: {
        connection: "warehouse",
        database: "analytics",
        schema_path: ["catalog"],
      },
      schemas: [schema("events", { tables_resolved: false })],
    };
    yield* service.updateSchemaList(NOTEBOOK_URI, operation);

    const catalog = (yield* getDatabase()).schemas.get("catalog");
    assert(catalog !== undefined);
    expect(catalog.childSchemasResolved).toBe(true);
    expect(catalog.childSchemas.get("events")?.tablesResolved).toBe(false);
    expect(catalog.tables.has("existing")).toBe(true);
  }).pipe(Effect.provide(DatasourcesService.Default)),
);

it.effect("merges tables at a nested schema path", () =>
  Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections([
        schema("catalog", {
          child_schemas: [schema("events", { tables_resolved: false })],
        }),
      ]),
    );

    const operation: SqlTableListPreviewNotification = {
      op: "sql-table-list-preview",
      request_id: requestId("tables"),
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

    const events = (yield* getDatabase()).schemas
      .get("catalog")
      ?.childSchemas.get("events");
    expect(events?.tablesResolved).toBe(true);
    expect(events?.tables.has("clicks")).toBe(true);
  }).pipe(Effect.provide(DatasourcesService.Default)),
);

it.effect("does not resolve deferred state after an error", () =>
  Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      NOTEBOOK_URI,
      connections([schema("public", { tables_resolved: false })]),
    );
    yield* service.updateTableList(NOTEBOOK_URI, {
      op: "sql-table-list-preview",
      request_id: requestId("tables"),
      metadata: {
        type: "sql-metadata",
        connection: "warehouse",
        database: "analytics",
        schema: "public",
      },
      tables: [],
      error: "connection lost",
    });

    expect((yield* getDatabase()).schemas.get("public")?.tablesResolved).toBe(
      false,
    );
  }).pipe(Effect.provide(DatasourcesService.Default)),
);
