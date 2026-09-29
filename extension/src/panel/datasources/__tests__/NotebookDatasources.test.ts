import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import * as MarimoClientTest from "../../../__tests__/fake/MarimoClient.ts";
import * as EffectTest from "../../../__tests__/lib/EffectTest.ts";
import { makeScopedResourceCounter } from "../../../__tests__/lib/scopedResourceCounter.ts";
import { requestId } from "../../../lib/__tests__/branded.ts";
import type { SqlTableListPreviewNotification } from "../../../types.ts";
import * as TestNotebookDatasources from "./TestNotebookDatasources.ts";

const schemaRequest = (request: MarimoClientTest.Command) => {
  if (request.kind !== "list-sql-schemas") {
    throw new Error(`Expected list-sql-schemas, received ${request.kind}`);
  }
  return request;
};

const tableRequest = (request: MarimoClientTest.Command) => {
  if (request.kind !== "list-sql-tables") {
    throw new Error(`Expected list-sql-tables, received ${request.kind}`);
  }
  return request;
};

const getDatabase = Effect.fn(function* () {
  const datasources = yield* TestNotebookDatasources.Service;
  const state = Option.getOrThrow(
    yield* datasources.getConnections(TestNotebookDatasources.NOTEBOOK_URI),
  );
  return Option.fromNullishOr(
    state.connections.get("warehouse")?.databases.get("analytics"),
  ).pipe(Option.getOrThrow);
});

Vitest.describe("NotebookDatasources", () => {
  const it = EffectTest.make(TestNotebookDatasources.layer);

  it.effect("preserves recursive schemas and deferred discovery", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections(
          [
            TestNotebookDatasources.schema("catalog", {
              tables_resolved: false,
              child_schemas_resolved: false,
              child_schemas: [
                TestNotebookDatasources.schema("loaded", {
                  tables: [TestNotebookDatasources.table("events")],
                }),
              ],
            }),
          ],
          false,
        ),
      );

      const database = yield* getDatabase();
      const catalog = database.schemas.get("catalog");
      Vitest.expect(database.schemasResolved).toBe(false);
      Vitest.expect(catalog?.tablesResolved).toBe(false);
      Vitest.expect(catalog?.childSchemasResolved).toBe(false);
      Vitest.expect(
        catalog?.childSchemas.get("loaded")?.tables.has("events"),
      ).toBe(true);
    }),
  );

  it.effect("isolates datasource state by document session", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const displaced = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        displaced,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([
          TestNotebookDatasources.schema("old"),
        ]),
      );

      yield* datasources.replaceSession;
      Vitest.expect(
        Option.isNone(
          yield* datasources.getConnections(
            TestNotebookDatasources.NOTEBOOK_URI,
          ),
        ),
      ).toBe(true);
      const replacement = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        replacement,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([
          TestNotebookDatasources.schema("new"),
        ]),
      );
      yield* datasources.closeDisplaced;
      yield* datasources.updateConnections(
        displaced,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([
          TestNotebookDatasources.schema("late"),
        ]),
      );
      yield* datasources.selectDisplaced;
      Vitest.expect(
        Option.isNone(
          yield* datasources.getConnections(
            TestNotebookDatasources.NOTEBOOK_URI,
          ),
        ),
      ).toBe(true);
      yield* datasources.selectReplacement;

      const database = yield* getDatabase();
      Vitest.expect(database.schemas.has("new")).toBe(true);
      Vitest.expect(database.schemas.has("old")).toBe(false);
    }),
  );

  it.effect(
    "keeps kernel replacement independent from document ownership",
    () =>
      Effect.gen(function* () {
        const datasources = yield* TestNotebookDatasources.Service;
        const session = yield* datasources.currentSession;
        yield* datasources.updateConnections(
          session,
          TestNotebookDatasources.KERNEL_SESSION_ID,
          TestNotebookDatasources.connections([
            TestNotebookDatasources.schema("old"),
          ]),
        );
        yield* datasources.updateDatasets(
          session,
          TestNotebookDatasources.REPLACEMENT_KERNEL_SESSION_ID,
          {
            op: "datasets",
            tables: [TestNotebookDatasources.table("fresh")],
          },
        );
        Vitest.expect(
          Option.isNone(
            yield* datasources.getConnections(
              TestNotebookDatasources.NOTEBOOK_URI,
            ),
          ),
        ).toBe(true);
        yield* datasources.updateConnections(
          session,
          TestNotebookDatasources.REPLACEMENT_KERNEL_SESSION_ID,
          TestNotebookDatasources.connections([
            TestNotebookDatasources.schema("new"),
          ]),
        );
        yield* datasources.clearKernelSession(
          TestNotebookDatasources.NOTEBOOK_URI,
          TestNotebookDatasources.KERNEL_SESSION_ID,
        );

        const datasets = Option.getOrThrow(
          yield* datasources.getDatasets(TestNotebookDatasources.NOTEBOOK_URI),
        );
        Vitest.expect(datasets.tables.has("fresh")).toBe(true);
      }),
  );

  it.effect("merges child schemas at their parent path", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([
          TestNotebookDatasources.schema("catalog", {
            tables: [TestNotebookDatasources.table("existing")],
            child_schemas_resolved: false,
          }),
        ]),
      );
      const load = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", ["catalog"])
        .pipe(Effect.forkChild);
      const call = schemaRequest(yield* datasources.nextRequest);
      yield* datasources.updateSchemaList(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        {
          op: "sql-schema-list-preview",
          request_id: requestId(call.requestId),
          metadata: {
            connection: "warehouse",
            database: "analytics",
            schema_path: ["catalog"],
          },
          schemas: [
            TestNotebookDatasources.schema("events", {
              tables_resolved: false,
            }),
          ],
        },
      );
      yield* Fiber.join(load);

      const catalog = (yield* getDatabase()).schemas.get("catalog");
      Vitest.expect(catalog?.childSchemasResolved).toBe(true);
      Vitest.expect(catalog?.childSchemas.get("events")?.tablesResolved).toBe(
        false,
      );
      Vitest.expect(catalog?.tables.has("existing")).toBe(true);
    }),
  );

  it.effect("merges tables at a nested schema path", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([
          TestNotebookDatasources.schema("catalog", {
            child_schemas: [
              TestNotebookDatasources.schema("events", {
                tables_resolved: false,
              }),
            ],
          }),
        ]),
      );
      const load = yield* datasources
        .loadTables(session, "warehouse", "analytics", "events", [
          "catalog",
          "events",
        ])
        .pipe(Effect.forkChild);
      const call = tableRequest(yield* datasources.nextRequest);
      yield* datasources.updateTableList(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        {
          op: "sql-table-list-preview",
          request_id: requestId(call.requestId),
          metadata: {
            type: "sql-metadata",
            connection: "warehouse",
            database: "analytics",
            schema: "events",
            schema_path: ["catalog", "events"],
          },
          tables: [TestNotebookDatasources.table("clicks")],
        },
      );
      yield* Fiber.join(load);

      const events = (yield* getDatabase()).schemas
        .get("catalog")
        ?.childSchemas.get("events");
      Vitest.expect(events?.tablesResolved).toBe(true);
      Vitest.expect(events?.tables.has("clicks")).toBe(true);
    }),
  );

  it.effect("does not resolve deferred state after an error", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([
          TestNotebookDatasources.schema("public", { tables_resolved: false }),
        ]),
      );
      const load = yield* Effect.result(
        datasources.loadTables(session, "warehouse", "analytics", "public", [
          "public",
        ]),
      ).pipe(Effect.forkChild);
      const call = tableRequest(yield* datasources.nextRequest);
      yield* datasources.updateTableList(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        {
          op: "sql-table-list-preview",
          request_id: requestId(call.requestId),
          metadata: {
            type: "sql-metadata",
            connection: "warehouse",
            database: "analytics",
            schema: "public",
          },
          tables: [],
          error: "connection lost",
        },
      );

      Vitest.expect((yield* Fiber.join(load))._tag).toBe("Failure");
      Vitest.expect(
        (yield* getDatabase()).schemas.get("public")?.tablesResolved,
      ).toBe(false);
    }),
  );

  it.effect("ignores uncorrelated expansion responses", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections(
          [
            TestNotebookDatasources.schema("public", {
              tables_resolved: false,
            }),
          ],
          false,
        ),
      );
      yield* datasources.updateSchemaList(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        {
          op: "sql-schema-list-preview",
          request_id: requestId("stale-schemas"),
          metadata: { connection: "warehouse", database: "analytics" },
          schemas: [TestNotebookDatasources.schema("stale")],
        },
      );
      yield* datasources.updateTableList(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        {
          op: "sql-table-list-preview",
          request_id: requestId("stale-tables"),
          metadata: {
            type: "sql-metadata",
            connection: "warehouse",
            database: "analytics",
            schema: "public",
          },
          tables: [TestNotebookDatasources.table("stale")],
        },
      );

      const database = yield* getDatabase();
      Vitest.expect(database.schemasResolved).toBe(false);
      Vitest.expect(database.schemas.has("stale")).toBe(false);
      Vitest.expect(database.schemas.get("public")?.tablesResolved).toBe(false);
      Vitest.expect(database.schemas.get("public")?.tables.has("stale")).toBe(
        false,
      );
    }),
  );

  it.effect("deduplicates concurrent schema expansion requests", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([], false),
      );
      const first = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", [])
        .pipe(Effect.forkChild);
      const second = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", [])
        .pipe(Effect.forkChild);
      const call = schemaRequest(yield* datasources.nextRequest);
      yield* datasources.updateSchemaList(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        {
          op: "sql-schema-list-preview",
          request_id: requestId(call.requestId),
          metadata: { connection: "warehouse", database: "analytics" },
          schemas: [TestNotebookDatasources.schema("public")],
        },
      );
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      Vitest.expect(yield* datasources.requests).toHaveLength(1);
      Vitest.expect((yield* getDatabase()).schemas.has("public")).toBe(true);
    }),
  );

  it.effect("releases resources owned by completed expansions", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      const resources = yield* makeScopedResourceCounter();
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([], false),
      );

      for (let index = 0; index < 3; index++) {
        const load = yield* resources
          .track(datasources.loadSchemas(session, "warehouse", "analytics", []))
          .pipe(Effect.forkChild);
        const request = schemaRequest(yield* datasources.nextRequest);
        Vitest.expect(yield* resources.counts).toEqual({
          acquired: index + 1,
          released: index,
          active: 1,
        });
        yield* datasources.updateSchemaList(
          session,
          TestNotebookDatasources.KERNEL_SESSION_ID,
          {
            op: "sql-schema-list-preview",
            request_id: requestId(request.requestId),
            metadata: { connection: "warehouse", database: "analytics" },
            schemas: [TestNotebookDatasources.schema(`schema_${index}`)],
          },
        );
        yield* Fiber.join(load);
        Vitest.expect(yield* resources.counts).toEqual({
          acquired: index + 1,
          released: index + 1,
          active: 0,
        });
        yield* datasources.updateConnections(
          session,
          TestNotebookDatasources.KERNEL_SESSION_ID,
          TestNotebookDatasources.connections([], false),
        );
      }
      yield* datasources.closeCurrent;
    }),
  );

  it.effect("retries nested table expansion after an error", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([
          TestNotebookDatasources.schema("catalog", {
            child_schemas: [
              TestNotebookDatasources.schema("events", {
                tables_resolved: false,
              }),
            ],
          }),
        ]),
      );
      const first = yield* Effect.result(
        datasources.loadTables(session, "warehouse", "analytics", "events", [
          "catalog",
          "events",
        ]),
      ).pipe(Effect.forkChild);
      const call = tableRequest(yield* datasources.nextRequest);
      Vitest.expect(call).toMatchObject({
        engine: "warehouse",
        database: "analytics",
        schema: "events",
        schemaPath: ["catalog", "events"],
      });
      const error: SqlTableListPreviewNotification = {
        op: "sql-table-list-preview",
        request_id: requestId(call.requestId),
        metadata: {
          type: "sql-metadata",
          connection: "warehouse",
          database: "analytics",
          schema: "events",
          schema_path: ["catalog", "events"],
        },
        tables: [],
        error: "connection lost",
      };
      yield* datasources.updateTableList(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        error,
      );
      Vitest.expect((yield* Fiber.join(first))._tag).toBe("Failure");

      const retry = yield* datasources
        .loadTables(session, "warehouse", "analytics", "events", [
          "catalog",
          "events",
        ])
        .pipe(Effect.forkChild);
      const retryCall = yield* datasources.nextRequest;
      Vitest.expect(retryCall.kind).toBe("list-sql-tables");
      Vitest.expect(yield* datasources.requests).toHaveLength(2);
      yield* Fiber.interrupt(retry);
    }),
  );

  it.effect("shares one timeout deadline and retries after it expires", () =>
    Effect.gen(function* () {
      const datasources = yield* TestNotebookDatasources.Service;
      const session = yield* datasources.currentSession;
      yield* datasources.updateConnections(
        session,
        TestNotebookDatasources.KERNEL_SESSION_ID,
        TestNotebookDatasources.connections([], false),
      );
      const first = yield* Effect.result(
        datasources.loadSchemas(session, "warehouse", "analytics", []),
      ).pipe(Effect.forkChild);
      const firstCall = yield* datasources.nextRequest;
      Vitest.expect(firstCall.kind).toBe("list-sql-schemas");
      yield* TestClock.adjust("20 seconds");
      const joined = yield* Effect.result(
        datasources.loadSchemas(session, "warehouse", "analytics", []),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      Vitest.expect((yield* Fiber.join(first))._tag).toBe("Failure");
      Vitest.expect((yield* Fiber.join(joined))._tag).toBe("Failure");
      Vitest.expect(yield* datasources.requests).toHaveLength(1);

      const retry = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", [])
        .pipe(Effect.forkChild);
      const retryCall = yield* datasources.nextRequest;
      Vitest.expect(retryCall.kind).toBe("list-sql-schemas");
      Vitest.expect(yield* datasources.requests).toHaveLength(2);
      yield* Fiber.interrupt(retry);
    }),
  );

  Vitest.describe("when a transport send is blocked", () => {
    const it = EffectTest.make(
      TestNotebookDatasources.layerWith(
        TestNotebookDatasources.Scenario.BlockedSend(),
      ),
    );

    it.effect(
      "interrupts an expansion send when its document session closes",
      Effect.fn(function* () {
        const datasources = yield* TestNotebookDatasources.Service;
        const session = yield* datasources.currentSession;
        yield* datasources.updateConnections(
          session,
          TestNotebookDatasources.KERNEL_SESSION_ID,
          TestNotebookDatasources.connections([], false),
        );
        const load = yield* datasources
          .loadSchemas(session, "warehouse", "analytics", [])
          .pipe(Effect.forkChild);
        yield* datasources.sendStarted;
        const close = yield* datasources.closeCurrent.pipe(Effect.forkChild);
        yield* Fiber.join(close);

        Vitest.expect((yield* Fiber.await(load))._tag).toBe("Failure");
        yield* datasources.sendFinalized;
        yield* datasources.releaseSend;
        Vitest.expect(yield* datasources.requests).toEqual([]);
      }),
    );
  });
});
