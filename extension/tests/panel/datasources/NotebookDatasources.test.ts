import * as Vitest from "@effect/vitest";
import {
  Context,
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  Queue,
  Ref,
} from "effect";
import { TestClock } from "effect/testing";
import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../../../src/constants.ts";
import * as NotebookDocumentSessions from "../../../src/notebook/NotebookDocumentSessions.ts";
import * as NotebookDatasources from "../../../src/panel/datasources/NotebookDatasources.ts";
import type {
  DataSourceConnectionsNotification,
  DatabaseSchema,
  DataTable,
  SqlTableListPreviewNotification,
} from "../../../src/types.ts";
import * as MarimoClientTest from "../../fake/MarimoClient.ts";
import * as VsCodeTest from "../../fake/VsCode.ts";
import { kernelSessionId, notebookId, requestId } from "../../lib/branded.ts";
import * as EffectTest from "../../lib/EffectTest.ts";
import { makeScopedResourceCounter } from "../../lib/scopedResourceCounter.ts";
import * as DocumentLifecycle from "../../notebook/documentLifecycle.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const KERNEL_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000001",
);
const REPLACEMENT_KERNEL_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000002",
);

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
): DatabaseSchema => ({ name, tables: [], ...options });

const connections = (
  schemas: ReadonlyArray<DatabaseSchema>,
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
          schemas: [...schemas],
          schemas_resolved: schemasResolved,
        },
      ],
    },
  ],
});

/** Commands the fake server completed, in order, plus the send gate. */
class Requests extends Context.Service<
  Requests,
  {
    readonly completed: Ref.Ref<ReadonlyArray<MarimoClientTest.Command>>;
    readonly queue: Queue.Queue<MarimoClientTest.Command>;
    readonly sendStarted: Latch.Latch;
    readonly sendFinalized: Latch.Latch;
    readonly releaseSend: Latch.Latch;
  }
>()("@marimo/test/NotebookDatasources/Requests") {}

const makeDocument = () =>
  VsCodeTest.createTestNotebookDocument(VsCodeTest.Uri.parse(NOTEBOOK_URI), {
    notebookType: NOTEBOOK_TYPE,
  });

const layerWith = (options: { readonly blockSend: boolean }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const completed = yield* Ref.make<
        ReadonlyArray<MarimoClientTest.Command>
      >([]);
      const queue = yield* Queue.unbounded<MarimoClientTest.Command>();
      const sendStarted = yield* Latch.make();
      const sendFinalized = yield* Latch.make();
      const releaseSend = yield* Latch.make();
      // Records on completion, so an interrupted send leaves no trace.
      const record = (request: MarimoClientTest.Command) =>
        Ref.update(completed, (all) => [...all, request]).pipe(
          Effect.andThen(Queue.offer(queue, request)),
          Effect.asVoid,
        );
      const send = (request: MarimoClientTest.Command) =>
        options.blockSend
          ? sendStarted.open.pipe(
              Effect.andThen(releaseSend.await),
              Effect.andThen(record(request)),
              Effect.ensuring(sendFinalized.open),
              Effect.as(null),
            )
          : record(request).pipe(Effect.as(null));
      return Layer.merge(
        NotebookDatasources.layer.pipe(
          Layer.provide(MarimoClientTest.layerWith({ send })),
          Layer.provideMerge(NotebookDocumentSessions.layer),
          Layer.provideMerge(
            VsCodeTest.layerWith({ initialDocuments: [makeDocument()] }),
          ),
        ),
        Layer.succeed(Requests, {
          completed,
          queue,
          sendStarted,
          sendFinalized,
          releaseSend,
        }),
      );
    }),
  );

const currentSession = Effect.gen(function* () {
  const sessions = yield* NotebookDocumentSessions.Service;
  return Option.getOrThrow(sessions.current(NOTEBOOK_URI));
});

/** Opens a fresh document at the same URI, displacing the current session. */
const replaceSession = Effect.suspend(() =>
  DocumentLifecycle.transition(makeDocument(), "opened"),
);

const closeCurrent = Effect.gen(function* () {
  const session = yield* currentSession;
  yield* DocumentLifecycle.transition(session.document, "closed");
});

const closeDocument = (document: vscode.NotebookDocument) =>
  Effect.flatMap(VsCodeTest.Service, (vscode) =>
    vscode.closeNotebook(document),
  );

const requests = Effect.flatMap(Requests, (r) => Ref.get(r.completed));
const nextRequest = Effect.flatMap(Requests, (r) => Queue.take(r.queue));
const sendStarted = Effect.flatMap(Requests, (r) => r.sendStarted.await);
const sendFinalized = Effect.flatMap(Requests, (r) => r.sendFinalized.await);
const releaseSend = Effect.flatMap(Requests, (r) => r.releaseSend.open);

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
  const datasources = yield* NotebookDatasources.Service;
  const state = Option.getOrThrow(
    yield* datasources.getConnections(NOTEBOOK_URI),
  );
  return Option.fromNullishOr(
    state.connections.get("warehouse")?.databases.get("analytics"),
  ).pipe(Option.getOrThrow);
});

Vitest.describe("NotebookDatasources", () => {
  const it = EffectTest.make(layerWith({ blockSend: false }));

  it.effect("preserves recursive schemas and deferred discovery", () =>
    Effect.gen(function* () {
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections(
          [
            schema("catalog", {
              tables_resolved: false,
              child_schemas_resolved: false,
              child_schemas: [
                schema("loaded", {
                  tables: [table("events")],
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
      const datasources = yield* NotebookDatasources.Service;
      const displaced = yield* currentSession;
      yield* datasources.updateConnections(
        displaced,
        KERNEL_SESSION_ID,
        connections([schema("old")]),
      );

      yield* replaceSession;
      Vitest.expect(
        Option.isNone(yield* datasources.getConnections(NOTEBOOK_URI)),
      ).toBe(true);
      const replacement = yield* currentSession;
      yield* datasources.updateConnections(
        replacement,
        KERNEL_SESSION_ID,
        connections([schema("new")]),
      );
      yield* closeDocument(displaced.document);
      yield* datasources.updateConnections(
        displaced,
        KERNEL_SESSION_ID,
        connections([schema("late")]),
      );

      const database = yield* getDatabase();
      Vitest.expect(database.schemas.has("new")).toBe(true);
      Vitest.expect(database.schemas.has("late")).toBe(false);
      Vitest.expect(database.schemas.has("old")).toBe(false);
    }),
  );

  it.effect(
    "keeps kernel replacement independent from document ownership",
    () =>
      Effect.gen(function* () {
        const datasources = yield* NotebookDatasources.Service;
        const session = yield* currentSession;
        yield* datasources.updateConnections(
          session,
          KERNEL_SESSION_ID,
          connections([schema("old")]),
        );
        yield* datasources.updateDatasets(
          session,
          REPLACEMENT_KERNEL_SESSION_ID,
          {
            op: "datasets",
            tables: [table("fresh")],
          },
        );
        Vitest.expect(
          Option.isNone(yield* datasources.getConnections(NOTEBOOK_URI)),
        ).toBe(true);
        yield* datasources.updateConnections(
          session,
          REPLACEMENT_KERNEL_SESSION_ID,
          connections([schema("new")]),
        );
        yield* datasources.clearKernelSession(NOTEBOOK_URI, KERNEL_SESSION_ID);

        // Clearing the old kernel must not touch the replacement kernel's state.
        Vitest.expect((yield* getDatabase()).schemas.has("new")).toBe(true);
        const datasets = Option.getOrThrow(
          yield* datasources.getDatasets(NOTEBOOK_URI),
        );
        Vitest.expect(datasets.tables.has("fresh")).toBe(true);
      }),
  );

  it.effect("merges child schemas at their parent path", () =>
    Effect.gen(function* () {
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([
          schema("catalog", {
            tables: [table("existing")],
            child_schemas_resolved: false,
          }),
        ]),
      );
      const load = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", ["catalog"])
        .pipe(Effect.forkChild);
      const call = schemaRequest(yield* nextRequest);
      yield* datasources.updateSchemaList(session, KERNEL_SESSION_ID, {
        op: "sql-schema-list-preview",
        request_id: requestId(call.requestId),
        metadata: {
          connection: "warehouse",
          database: "analytics",
          schema_path: ["catalog"],
        },
        schemas: [
          schema("events", {
            tables_resolved: false,
          }),
        ],
      });
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
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([
          schema("catalog", {
            child_schemas: [
              schema("events", {
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
      const call = tableRequest(yield* nextRequest);
      yield* datasources.updateTableList(session, KERNEL_SESSION_ID, {
        op: "sql-table-list-preview",
        request_id: requestId(call.requestId),
        metadata: {
          type: "sql-metadata",
          connection: "warehouse",
          database: "analytics",
          schema: "events",
          schema_path: ["catalog", "events"],
        },
        tables: [table("clicks")],
      });
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
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([schema("public", { tables_resolved: false })]),
      );
      const load = yield* Effect.result(
        datasources.loadTables(session, "warehouse", "analytics", "public", [
          "public",
        ]),
      ).pipe(Effect.forkChild);
      const call = tableRequest(yield* nextRequest);
      yield* datasources.updateTableList(session, KERNEL_SESSION_ID, {
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
      });

      Vitest.expect((yield* Fiber.join(load))._tag).toBe("Failure");
      Vitest.expect(
        (yield* getDatabase()).schemas.get("public")?.tablesResolved,
      ).toBe(false);
    }),
  );

  it.effect("ignores uncorrelated expansion responses", () =>
    Effect.gen(function* () {
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections(
          [
            schema("public", {
              tables_resolved: false,
            }),
          ],
          false,
        ),
      );
      yield* datasources.updateSchemaList(session, KERNEL_SESSION_ID, {
        op: "sql-schema-list-preview",
        request_id: requestId("stale-schemas"),
        metadata: { connection: "warehouse", database: "analytics" },
        schemas: [schema("stale")],
      });
      yield* datasources.updateTableList(session, KERNEL_SESSION_ID, {
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
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([], false),
      );
      const first = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", [])
        .pipe(Effect.forkChild);
      const second = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", [])
        .pipe(Effect.forkChild);
      const call = schemaRequest(yield* nextRequest);
      yield* datasources.updateSchemaList(session, KERNEL_SESSION_ID, {
        op: "sql-schema-list-preview",
        request_id: requestId(call.requestId),
        metadata: { connection: "warehouse", database: "analytics" },
        schemas: [schema("public")],
      });
      yield* Fiber.join(first);
      yield* Fiber.join(second);

      Vitest.expect(yield* requests).toHaveLength(1);
      const database = yield* getDatabase();
      Vitest.expect(database.schemas.has("public")).toBe(true);
      Vitest.expect(database.schemasResolved).toBe(true);
    }),
  );

  it.effect("releases resources owned by completed expansions", () =>
    Effect.gen(function* () {
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      const resources = yield* makeScopedResourceCounter();
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([], false),
      );

      for (let index = 0; index < 3; index++) {
        const load = yield* resources
          .track(datasources.loadSchemas(session, "warehouse", "analytics", []))
          .pipe(Effect.forkChild);
        const request = schemaRequest(yield* nextRequest);
        Vitest.expect(yield* resources.counts).toEqual({
          acquired: index + 1,
          released: index,
          active: 1,
        });
        yield* datasources.updateSchemaList(session, KERNEL_SESSION_ID, {
          op: "sql-schema-list-preview",
          request_id: requestId(request.requestId),
          metadata: { connection: "warehouse", database: "analytics" },
          schemas: [schema(`schema_${index}`)],
        });
        yield* Fiber.join(load);
        Vitest.expect(yield* resources.counts).toEqual({
          acquired: index + 1,
          released: index + 1,
          active: 0,
        });
        yield* datasources.updateConnections(
          session,
          KERNEL_SESSION_ID,
          connections([], false),
        );
      }
      yield* closeCurrent;
    }),
  );

  it.effect("retries nested table expansion after an error", () =>
    Effect.gen(function* () {
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([
          schema("catalog", {
            child_schemas: [
              schema("events", {
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
      const call = tableRequest(yield* nextRequest);
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
      yield* datasources.updateTableList(session, KERNEL_SESSION_ID, error);
      Vitest.expect((yield* Fiber.join(first))._tag).toBe("Failure");

      const retry = yield* datasources
        .loadTables(session, "warehouse", "analytics", "events", [
          "catalog",
          "events",
        ])
        .pipe(Effect.forkChild);
      const retryCall = yield* nextRequest;
      Vitest.expect(retryCall.kind).toBe("list-sql-tables");
      Vitest.expect(yield* requests).toHaveLength(2);
      yield* Fiber.interrupt(retry);
    }),
  );

  it.effect("shares one timeout deadline and retries after it expires", () =>
    Effect.gen(function* () {
      const datasources = yield* NotebookDatasources.Service;
      const session = yield* currentSession;
      yield* datasources.updateConnections(
        session,
        KERNEL_SESSION_ID,
        connections([], false),
      );
      const first = yield* Effect.result(
        datasources.loadSchemas(session, "warehouse", "analytics", []),
      ).pipe(Effect.forkChild);
      const firstCall = yield* nextRequest;
      Vitest.expect(firstCall.kind).toBe("list-sql-schemas");
      yield* TestClock.adjust("20 seconds");
      const joined = yield* Effect.result(
        datasources.loadSchemas(session, "warehouse", "analytics", []),
      ).pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      Vitest.expect((yield* Fiber.join(first))._tag).toBe("Failure");
      Vitest.expect((yield* Fiber.join(joined))._tag).toBe("Failure");
      Vitest.expect(yield* requests).toHaveLength(1);

      const retry = yield* datasources
        .loadSchemas(session, "warehouse", "analytics", [])
        .pipe(Effect.forkChild);
      const retryCall = yield* nextRequest;
      Vitest.expect(retryCall.kind).toBe("list-sql-schemas");
      Vitest.expect(yield* requests).toHaveLength(2);
      yield* Fiber.interrupt(retry);
    }),
  );

  Vitest.describe("when a transport send is blocked", () => {
    const it = EffectTest.make(layerWith({ blockSend: true }));

    it.effect(
      "interrupts an expansion send when its document session closes",
      Effect.fn(function* () {
        const datasources = yield* NotebookDatasources.Service;
        const session = yield* currentSession;
        yield* datasources.updateConnections(
          session,
          KERNEL_SESSION_ID,
          connections([], false),
        );
        const load = yield* datasources
          .loadSchemas(session, "warehouse", "analytics", [])
          .pipe(Effect.forkChild);
        yield* sendStarted;
        const close = yield* closeCurrent.pipe(Effect.forkChild);
        yield* Fiber.join(close);

        Vitest.expect((yield* Fiber.await(load))._tag).toBe("Failure");
        yield* sendFinalized;
        yield* releaseSend;
        Vitest.expect(yield* requests).toEqual([]);
      }),
    );
  });
});
