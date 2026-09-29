import {
  Context,
  Data,
  Effect,
  Exit,
  Latch,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Stream,
} from "effect";

import * as MarimoClientTest from "../../../__tests__/fake/MarimoClient.ts";
import * as VsCodeValues from "../../../__tests__/fake/VsCodeValues.ts";
import { makeTestNotebookDocumentSession } from "../../../__tests__/lib/notebookDocumentSession.ts";
import { NOTEBOOK_TYPE } from "../../../constants.ts";
import { kernelSessionId, notebookId } from "../../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../../../notebook/NotebookDocumentSessions.ts";
import type {
  DataSourceConnectionsNotification,
  DatabaseSchema,
  DataTable,
} from "../../../types.ts";
import * as NotebookDatasources from "../NotebookDatasources.ts";

export const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
export const KERNEL_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000001",
);
export const REPLACEMENT_KERNEL_SESSION_ID = kernelSessionId(
  "00000000-0000-4000-8000-000000000002",
);

export type Scenario = Data.TaggedEnum<{
  Recording: {};
  BlockedSend: {};
}>;
export const Scenario = Data.taggedEnum<Scenario>();

export interface Interface extends NotebookDatasources.Interface {
  readonly currentSession: Effect.Effect<NotebookDocumentSessions.Session>;
  readonly displacedSession: Effect.Effect<NotebookDocumentSessions.Session>;
  readonly replaceSession: Effect.Effect<void>;
  readonly selectDisplaced: Effect.Effect<void>;
  readonly selectReplacement: Effect.Effect<void>;
  readonly closeCurrent: Effect.Effect<void>;
  readonly closeDisplaced: Effect.Effect<void>;
  readonly requests: Effect.Effect<ReadonlyArray<MarimoClientTest.Command>>;
  readonly nextRequest: Effect.Effect<MarimoClientTest.Command>;
  readonly sendStarted: Effect.Effect<void>;
  readonly sendFinalized: Effect.Effect<void>;
  readonly releaseSend: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookDatasources",
) {}

export const table = (name: string): DataTable => ({
  name,
  source: "warehouse",
  source_type: "connection",
  num_rows: null,
  num_columns: null,
  variable_name: null,
  columns: [],
});

export const schema = (
  name: string,
  options: Partial<DatabaseSchema> = {},
): DatabaseSchema => ({ name, tables: [], ...options });

export const connections = (
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

export const layerWith = (scenario: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const ownedSessions = new Set<NotebookDocumentSessions.Session>();
      const makeSession = () => {
        const session = makeTestNotebookDocumentSession(
          VsCodeValues.createTestNotebookDocument(
            VsCodeValues.Uri.parse(NOTEBOOK_URI),
            { notebookType: NOTEBOOK_TYPE },
          ),
        );
        ownedSessions.add(session);
        return session;
      };
      let current = makeSession();
      let replacement: NotebookDocumentSessions.Session | undefined;
      let displaced: NotebookDocumentSessions.Session | undefined;
      const requests = yield* Ref.make<ReadonlyArray<MarimoClientTest.Command>>(
        [],
      );
      const requestQueue = yield* Queue.unbounded<MarimoClientTest.Command>();
      const sendStarted = yield* Latch.make();
      const sendFinalized = yield* Latch.make();
      const releaseSend = yield* Latch.make();

      const record = (request: MarimoClientTest.Command) =>
        Ref.update(requests, (all) => [...all, request]).pipe(
          Effect.andThen(Queue.offer(requestQueue, request)),
          Effect.asVoid,
        );
      const send = (request: MarimoClientTest.Command) =>
        Scenario.$is("BlockedSend")(scenario)
          ? sendStarted.open.pipe(
              Effect.andThen(releaseSend.await),
              Effect.andThen(record(request)),
              Effect.ensuring(sendFinalized.open),
              Effect.as(null),
            )
          : record(request).pipe(Effect.as(null));
      const documentSessions = Layer.succeed(NotebookDocumentSessions.Service, {
        current: (notebookUri) =>
          notebookUri === current.notebookId
            ? Option.some(current)
            : Option.none(),
        forDocument: (document) =>
          current.document === document ? Option.some(current) : Option.none(),
        active: Stream.empty,
        subscribeLifecycle: Effect.succeed(Stream.empty),
      });
      const environment = NotebookDatasources.layer.pipe(
        Layer.provide([MarimoClientTest.layerWith({ send }), documentSessions]),
      );
      const testService = Layer.effect(
        Service,
        Effect.gen(function* () {
          const service = yield* NotebookDatasources.Service;
          return Service.of({
            ...service,
            currentSession: Effect.sync(() => current),
            displacedSession: Effect.suspend(() =>
              displaced === undefined
                ? Effect.die("No displaced document session")
                : Effect.succeed(displaced),
            ),
            replaceSession: Effect.sync(() => {
              displaced = current;
              replacement = makeSession();
              current = replacement;
            }),
            selectDisplaced: Effect.sync(() => {
              if (displaced === undefined) {
                throw new Error("No displaced document session");
              }
              current = displaced;
            }),
            selectReplacement: Effect.sync(() => {
              if (replacement === undefined) {
                throw new Error("No replacement document session");
              }
              current = replacement;
            }),
            closeCurrent: Effect.suspend(() =>
              Scope.close(current.scope, Exit.void),
            ),
            closeDisplaced: Effect.suspend(() =>
              displaced === undefined
                ? Effect.die("No displaced document session")
                : Scope.close(displaced.scope, Exit.void),
            ),
            requests: Ref.get(requests),
            nextRequest: Queue.take(requestQueue),
            sendStarted: sendStarted.await,
            sendFinalized: sendFinalized.await,
            releaseSend: releaseSend.open.pipe(Effect.asVoid),
          });
        }),
      ).pipe(Layer.provide(environment));

      yield* Effect.addFinalizer(() =>
        Effect.forEach(
          ownedSessions,
          (session) => Scope.close(session.scope, Exit.void),
          { discard: true },
        ),
      );
      return Layer.merge(environment, testService);
    }),
  );

export const layer = layerWith(Scenario.Recording());
