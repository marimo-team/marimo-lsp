import { Context, Effect, Layer, Option, Stream } from "effect";

import { makeTestNotebookDocumentSession } from "../../__tests__/__utils__/TestNotebookDocumentSession.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import * as NotebookVariables from "../../panel/variables/NotebookVariables.ts";
import {
  type MarimoNotebookDocument,
  type NotebookId,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { VariablesNotification } from "../../types.ts";

export interface Interface {
  readonly updateVariables: (
    notebook: MarimoNotebookDocument,
    notification: VariablesNotification,
  ) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/TopologicalCells",
) {}

export const layer = Layer.suspend(() => {
  const sessions = new Map<NotebookId, NotebookDocumentSessions.Session>();
  const documentSessions = Layer.succeed(NotebookDocumentSessions.Service, {
    current: (id: NotebookId) => Option.fromNullishOr(sessions.get(id)),
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
  const fixture = Layer.effect(
    Service,
    Effect.gen(function* () {
      const variables = yield* NotebookVariables.Service;
      return Service.of({
        updateVariables: (notebook, notification) => {
          const current = sessions.get(notebook.id);
          const session =
            current?.document === notebook.rawNotebookDocument
              ? current
              : makeTestNotebookDocumentSession(notebook.rawNotebookDocument);
          sessions.set(notebook.id, session);
          return variables.updateVariables(session, notification);
        },
      });
    }),
  ).pipe(Layer.provide(environment));

  return Layer.merge(environment, fixture);
});
