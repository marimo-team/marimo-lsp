import { assert, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Scope,
  Stream,
} from "effect";
import { TestClock } from "effect/testing";

import {
  createTestNotebookDocument,
  Uri,
} from "../../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { makeTestNotebookDocumentSession } from "../../../__tests__/__utils__/TestNotebookDocumentSession.ts";
import { NOTEBOOK_TYPE } from "../../../constants.ts";
import {
  kernelSessionId,
  notebookId,
  requestId,
} from "../../../lib/__tests__/branded.ts";
import {
  type NotebookDocumentSession,
  NotebookDocumentSessions,
} from "../../../notebook/NotebookDocumentSessions.ts";
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
const KERNEL_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000001",
);
const SESSION = makeTestNotebookDocumentSession(
  createTestNotebookDocument(Uri.parse(NOTEBOOK_URI), {
    notebookType: NOTEBOOK_TYPE,
  }),
);

const makeLayer = (
  execute: (request: MarimoApiCall) => Effect.Effect<unknown> = () =>
    Effect.succeed(null),
  currentSession: () => NotebookDocumentSession = () => SESSION,
) =>
  Layer.effect(DatasourcesService, DatasourcesService.make).pipe(
    Layer.provide([
      makeTestMarimoClient({ execute }),
      Layer.succeed(NotebookDocumentSessions, {
        current: (notebookUri) =>
          notebookUri === currentSession().notebookId
            ? Option.some(currentSession())
            : Option.none(),
        forDocument: (document) => {
          const session = currentSession();
          return session.document === document
            ? Option.some(session)
            : Option.none();
        },
        active: Stream.empty,
      }),
    ]),
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
      SESSION,
      KERNEL_SESSION_ID,
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

it.effect("isolates datasource state by document session", () => {
  const displaced = makeTestNotebookDocumentSession(
    createTestNotebookDocument(Uri.parse(NOTEBOOK_URI), {
      notebookType: NOTEBOOK_TYPE,
    }),
  );
  const replacement = makeTestNotebookDocumentSession(
    createTestNotebookDocument(Uri.parse(NOTEBOOK_URI), {
      notebookType: NOTEBOOK_TYPE,
    }),
  );
  let current = displaced;
  const layer = makeLayer(
    () => Effect.succeed(null),
    () => current,
  );

  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      displaced,
      KERNEL_SESSION_ID,
      connections([schema("old")]),
    );

    current = replacement;
    expect(Option.isNone(yield* service.getConnections(NOTEBOOK_URI))).toBe(
      true,
    );

    yield* service.updateConnections(
      replacement,
      KERNEL_SESSION_ID,
      connections([schema("new")]),
    );
    yield* Scope.close(displaced.scope, Exit.void);

    // A delayed notification cannot repopulate the ended session.
    yield* service.updateConnections(
      displaced,
      KERNEL_SESSION_ID,
      connections([schema("late")]),
    );
    current = displaced;
    expect(Option.isNone(yield* service.getConnections(NOTEBOOK_URI))).toBe(
      true,
    );
    current = replacement;

    const state = yield* service.getConnections(NOTEBOOK_URI);
    assert(Option.isSome(state));
    const database = state.value.connections
      .get("warehouse")
      ?.databases.get("analytics");
    expect(database?.schemas.has("new")).toBe(true);
    expect(database?.schemas.has("old")).toBe(false);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "keeps kernel replacement independent from document ownership",
  () => {
    const replacementKernelSessionId = kernelSessionId(
      "00000000-0000-4000-8000-000000000002",
    );

    return Effect.gen(function* () {
      const service = yield* DatasourcesService;
      yield* service.updateConnections(
        SESSION,
        KERNEL_SESSION_ID,
        connections([schema("old")]),
      );

      // The first notification from a replacement kernel starts fresh state.
      yield* service.updateDatasets(SESSION, replacementKernelSessionId, {
        op: "datasets",
        tables: [table("fresh")],
      });
      expect(Option.isNone(yield* service.getConnections(NOTEBOOK_URI))).toBe(
        true,
      );
      expect(Option.isSome(yield* service.getDatasets(NOTEBOOK_URI))).toBe(
        true,
      );

      yield* service.updateConnections(
        SESSION,
        replacementKernelSessionId,
        connections([schema("new")]),
      );
      yield* service.clearKernelSession(NOTEBOOK_URI, KERNEL_SESSION_ID);

      expect(Option.isSome(yield* service.getConnections(NOTEBOOK_URI))).toBe(
        true,
      );
      const datasets = yield* service.getDatasets(NOTEBOOK_URI);
      assert(Option.isSome(datasets));
      expect(datasets.value.tables.has("fresh")).toBe(true);
    }).pipe(Effect.provide(makeLayer()));
  },
);

it.effect("merges child schemas at their parent path", () => {
  const { calls, layer } = makeRecordingLayer();
  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      SESSION,
      KERNEL_SESSION_ID,
      connections([
        schema("catalog", {
          tables: [table("existing")],
          child_schemas_resolved: false,
        }),
      ]),
    );

    const load = yield* Effect.forkChild(
      service.loadSchemas(SESSION, "warehouse", "analytics", ["catalog"]),
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
    yield* service.updateSchemaList(SESSION, KERNEL_SESSION_ID, operation);
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
      SESSION,
      KERNEL_SESSION_ID,
      connections([
        schema("catalog", {
          child_schemas: [schema("events", { tables_resolved: false })],
        }),
      ]),
    );

    const load = yield* Effect.forkChild(
      service.loadTables(SESSION, "warehouse", "analytics", "events", [
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
    yield* service.updateTableList(SESSION, KERNEL_SESSION_ID, operation);
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
      SESSION,
      KERNEL_SESSION_ID,
      connections([schema("public", { tables_resolved: false })]),
    );

    const load = yield* Effect.forkChild(
      Effect.result(
        service.loadTables(SESSION, "warehouse", "analytics", "public", [
          "public",
        ]),
      ),
    );
    yield* Effect.yieldNow;
    const call = calls[0];
    assert(call?.method === "list-sql-tables");

    yield* service.updateTableList(SESSION, KERNEL_SESSION_ID, {
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
    expect((yield* Fiber.join(load))._tag).toBe("Failure");

    expect((yield* getDatabase()).schemas.get("public")?.tablesResolved).toBe(
      false,
    );
  }).pipe(Effect.provide(layer));
});

it.effect("ignores uncorrelated expansion responses", () =>
  Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      SESSION,
      KERNEL_SESSION_ID,
      connections([schema("public", { tables_resolved: false })], false),
    );

    yield* service.updateSchemaList(SESSION, KERNEL_SESSION_ID, {
      op: "sql-schema-list-preview",
      request_id: requestId("stale-schemas"),
      metadata: { connection: "warehouse", database: "analytics" },
      schemas: [schema("stale")],
    });
    yield* service.updateTableList(SESSION, KERNEL_SESSION_ID, {
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
    yield* service.updateConnections(
      SESSION,
      KERNEL_SESSION_ID,
      connections([], false),
    );

    const first = yield* Effect.forkChild(
      service.loadSchemas(SESSION, "warehouse", "analytics", []),
    );
    const second = yield* Effect.forkChild(
      service.loadSchemas(SESSION, "warehouse", "analytics", []),
    );
    yield* Effect.yieldNow;

    expect(calls).toHaveLength(1);
    const call = calls[0];
    assert(call?.method === "list-sql-schemas");
    yield* service.updateSchemaList(SESSION, KERNEL_SESSION_ID, {
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

it.effect("interrupts an expansion send when its document session closes", () =>
  Effect.gen(function* () {
    const session = makeTestNotebookDocumentSession(
      createTestNotebookDocument(Uri.parse(NOTEBOOK_URI), {
        notebookType: NOTEBOOK_TYPE,
      }),
    );
    const sendStarted = yield* Deferred.make<void>();
    const releaseSend = yield* Deferred.make<void>();
    const calls: MarimoApiCall[] = [];
    let sendFinalized = false;
    const layer = makeLayer(
      (request) =>
        Deferred.succeed(sendStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseSend)),
          Effect.andThen(
            Effect.sync(() => {
              calls.push(request);
            }),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              sendFinalized = true;
            }),
          ),
        ),
      () => session,
    );

    yield* Effect.gen(function* () {
      const service = yield* DatasourcesService;
      yield* service.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([], false),
      );

      const load = yield* service
        .loadSchemas(session, "warehouse", "analytics", [])
        .pipe(Effect.result, Effect.forkChild);
      yield* Deferred.await(sendStarted);
      yield* Scope.close(session.scope, Exit.void);

      expect((yield* Fiber.join(load))._tag).toBe("Failure");
      expect(sendFinalized).toBe(true);
      yield* Deferred.succeed(releaseSend, undefined);
      yield* Effect.yieldNow;

      expect(calls).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect("retries nested table expansion after an error", () => {
  const calls: MarimoApiCall[] = [];
  const layer = makeLayer((request) => {
    calls.push(request);
    return Effect.succeed(null);
  });

  return Effect.gen(function* () {
    const service = yield* DatasourcesService;
    yield* service.updateConnections(
      SESSION,
      KERNEL_SESSION_ID,
      connections([
        schema("catalog", {
          child_schemas: [schema("events", { tables_resolved: false })],
        }),
      ]),
    );

    const first = yield* Effect.forkChild(
      Effect.result(
        service.loadTables(SESSION, "warehouse", "analytics", "events", [
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
    yield* service.updateTableList(SESSION, KERNEL_SESSION_ID, {
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
    expect((yield* Fiber.join(first))._tag).toBe("Failure");

    const retry = yield* Effect.forkChild(
      service.loadTables(SESSION, "warehouse", "analytics", "events", [
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
    yield* service.updateConnections(
      SESSION,
      KERNEL_SESSION_ID,
      connections([], false),
    );

    const first = yield* Effect.forkChild(
      Effect.result(service.loadSchemas(SESSION, "warehouse", "analytics", [])),
    );
    yield* Effect.yieldNow;
    expect(calls).toHaveLength(1);

    yield* TestClock.adjust("20 seconds");
    const joined = yield* Effect.forkChild(
      Effect.result(service.loadSchemas(SESSION, "warehouse", "analytics", [])),
    );
    yield* Effect.yieldNow;
    expect(calls).toHaveLength(1);

    yield* TestClock.adjust("10 seconds");
    expect((yield* Fiber.join(first))._tag).toBe("Failure");
    expect((yield* Fiber.join(joined))._tag).toBe("Failure");

    const retry = yield* Effect.forkChild(
      service.loadSchemas(SESSION, "warehouse", "analytics", []),
    );
    yield* Effect.yieldNow;
    expect(calls).toHaveLength(2);
    yield* Fiber.interrupt(retry);
  }).pipe(Effect.provide(layer));
});
