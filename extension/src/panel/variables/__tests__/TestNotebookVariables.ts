import {
  Context,
  Effect,
  Exit,
  Latch,
  Layer,
  Option,
  Scope,
  Stream,
} from "effect";

import * as VsCodeValues from "../../../__mocks__/VsCodeValues.ts";
import { makeTestNotebookDocumentSession } from "../../../__tests__/__utils__/TestNotebookDocumentSession.ts";
import { NOTEBOOK_TYPE } from "../../../constants.ts";
import { notebookId } from "../../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../../../notebook/NotebookDocumentSessions.ts";
import type { NotebookId } from "../../../schemas/MarimoNotebookDocument.ts";
import type {
  VariablesNotification,
  VariableValuesNotification,
} from "../../../types.ts";
import * as NotebookVariables from "../NotebookVariables.ts";

export const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
export const NOTEBOOK_URI_1 = notebookId("file:///test/notebook1.py");
export const NOTEBOOK_URI_2 = notebookId("file:///test/notebook2.py");

export interface Declaration {
  readonly name: string;
  readonly declared_by: ReadonlyArray<string>;
  readonly used_by: ReadonlyArray<string>;
}

export interface Value {
  readonly name: string;
  readonly value: string | number | null;
  readonly datatype: string | null;
}

export interface Interface {
  readonly current: (notebook?: NotebookId) => Effect.Effect<{
    readonly variables: Option.Option<NotebookVariables.Variables>;
    readonly values: Option.Option<NotebookVariables.Values>;
  }>;
  readonly updateDeclarations: (
    declarations: ReadonlyArray<Declaration>,
    notebook?: NotebookId,
  ) => Effect.Effect<void>;
  readonly updateValues: (
    values: ReadonlyArray<Value>,
    notebook?: NotebookId,
  ) => Effect.Effect<void>;
  readonly replaceSession: (notebook?: NotebookId) => Effect.Effect<void>;
  readonly closeCurrent: (notebook?: NotebookId) => Effect.Effect<void>;
  readonly closeDisplaced: (notebook?: NotebookId) => Effect.Effect<void>;
  readonly collectDeclarationChanges: (count: number) => Effect.Effect<number>;
  readonly collectValueChanges: (count: number) => Effect.Effect<number>;
  readonly declarationSubscriptionStarted: Effect.Effect<void>;
  readonly valueSubscriptionStarted: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookVariables",
) {}

const declarationsOperation = (
  declarations: ReadonlyArray<Declaration>,
): VariablesNotification => ({
  op: "variables",
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  variables: declarations as VariablesNotification["variables"],
});

const valuesOperation = (
  values: ReadonlyArray<Value>,
): VariableValuesNotification => ({
  op: "variable-values",
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  variables: values as VariableValuesNotification["variables"],
});

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const sessions = new Map<NotebookId, NotebookDocumentSessions.Session>();
    const displaced = new Map<NotebookId, NotebookDocumentSessions.Session>();
    const ownedSessions = new Set<NotebookDocumentSessions.Session>();
    const declarationSubscriptionStarted = yield* Latch.make();
    const valueSubscriptionStarted = yield* Latch.make();

    const makeSession = (id: NotebookId) => {
      const session = makeTestNotebookDocumentSession(
        VsCodeValues.createTestNotebookDocument(VsCodeValues.Uri.parse(id), {
          notebookType: NOTEBOOK_TYPE,
        }),
      );
      ownedSessions.add(session);
      return session;
    };
    const sessionFor = (id: NotebookId) => {
      const existing = sessions.get(id);
      if (existing !== undefined) return existing;
      const session = makeSession(id);
      sessions.set(id, session);
      return session;
    };
    const documentSessions = Layer.succeed(NotebookDocumentSessions.Service, {
      current: (id) => Option.fromNullishOr(sessions.get(id)),
      forDocument: (document) =>
        Option.fromNullishOr(
          Array.from(sessions.values()).find(
            (session) => session.document === document,
          ),
        ),
      active: Stream.empty,
      subscribeLifecycle: Effect.succeed(Stream.empty),
    });
    const environment = NotebookVariables.layer.pipe(
      Layer.provide(documentSessions),
    );
    const testService = Layer.effect(
      Service,
      Effect.gen(function* () {
        const service = yield* NotebookVariables.Service;
        return Service.of({
          current: (notebook = NOTEBOOK_URI) =>
            service.getAllVariableData(notebook),
          updateDeclarations: (declarations, notebook = NOTEBOOK_URI) =>
            service.updateVariables(
              sessionFor(notebook),
              declarationsOperation(declarations),
            ),
          updateValues: (values, notebook = NOTEBOOK_URI) =>
            service.updateVariableValues(
              sessionFor(notebook),
              valuesOperation(values),
            ),
          replaceSession: (notebook = NOTEBOOK_URI) =>
            Effect.sync(() => {
              displaced.set(notebook, sessionFor(notebook));
              sessions.set(notebook, makeSession(notebook));
            }),
          closeCurrent: (notebook = NOTEBOOK_URI) =>
            Scope.close(sessionFor(notebook).scope, Exit.void),
          closeDisplaced: (notebook = NOTEBOOK_URI) =>
            Option.match(Option.fromNullishOr(displaced.get(notebook)), {
              onNone: () => Effect.die(`No displaced session for ${notebook}`),
              onSome: (session) => Scope.close(session.scope, Exit.void),
            }),
          collectDeclarationChanges: (count) =>
            service.streamVariablesChanges.pipe(
              Stream.tap(() => declarationSubscriptionStarted.open),
              Stream.take(count),
              Stream.runCount,
            ),
          collectValueChanges: (count) =>
            service.streamVariableValuesChanges.pipe(
              Stream.tap(() => valueSubscriptionStarted.open),
              Stream.take(count),
              Stream.runCount,
            ),
          declarationSubscriptionStarted: declarationSubscriptionStarted.await,
          valueSubscriptionStarted: valueSubscriptionStarted.await,
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
