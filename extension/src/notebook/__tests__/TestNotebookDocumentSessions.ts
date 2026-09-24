import {
  Context,
  Effect,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { NotebookDocumentSessionId } from "../../schemas/SessionIds.ts";
import * as NotebookDocumentSessions from "../NotebookDocumentSessions.ts";

export interface Options {
  readonly initiallyOpen: boolean;
}

export interface Interface {
  readonly first: vscode.NotebookDocument;
  readonly replacement: vscode.NotebookDocument;
  readonly current: Effect.Effect<
    Option.Option<NotebookDocumentSessions.Session>
  >;
  readonly forDocument: (
    document: vscode.NotebookDocument,
  ) => Effect.Effect<Option.Option<NotebookDocumentSessions.Session>>;
  readonly openReplacement: Effect.Effect<void>;
  readonly closeFirst: Effect.Effect<void>;
  readonly closeReplacement: Effect.Effect<void>;
  readonly replayClosedFirst: Effect.Effect<void>;
  readonly activateFirst: Effect.Effect<void>;
  readonly activateReplacement: Effect.Effect<void>;
  readonly awaitActive: (
    sessionId: NotebookDocumentSessionId | null,
  ) => Effect.Effect<void>;
  readonly awaitActiveDocument: (
    document: vscode.NotebookDocument,
  ) => Effect.Effect<NotebookDocumentSessions.Session>;
  readonly awaitLifecycle: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookDocumentSessions",
) {}

export const layerWith = (options: Options) =>
  Layer.suspend(() => {
    const uri = TestVsCode.Uri.parse("file:///test/notebook.py");
    const id = notebookId(uri.toString());
    const first = TestVsCode.createTestNotebookDocument(uri);
    const replacement = TestVsCode.createTestNotebookDocument(uri);
    const vscodeLayer = TestVsCode.layerWith({
      initialDocuments: options.initiallyOpen ? [first] : [],
    });
    const environment = NotebookDocumentSessions.layer.pipe(
      Layer.provideMerge(vscodeLayer),
    );
    const fixture = Layer.effect(
      Service,
      Effect.gen(function* () {
        const vscode = yield* TestVsCode.Service;
        const sessions = yield* NotebookDocumentSessions.Service;
        let barrierId = 0;
        const active = yield* SubscriptionRef.make<
          ReadonlyArray<NotebookDocumentSessionId | null>
        >([]);
        yield* sessions.active.pipe(
          Stream.runForEach((session) =>
            SubscriptionRef.update(active, (observed) => [
              ...observed,
              Option.match(session, {
                onNone: () => null,
                onSome: (value) => value.id,
              }),
            ]),
          ),
          Effect.forkScoped({ startImmediately: true }),
        );

        const awaitActive = (sessionId: NotebookDocumentSessionId | null) =>
          SubscriptionRef.changes(active).pipe(
            Stream.filter((observed) => observed.at(-1) === sessionId),
            Stream.runHead,
            Effect.asVoid,
          );

        const awaitActiveDocument = (document: vscode.NotebookDocument) =>
          sessions.active.pipe(
            Stream.filter(
              Option.exists((session) => session.document === document),
            ),
            Stream.runHead,
            Effect.map((observed) =>
              Option.getOrThrow(Option.flatten(observed)),
            ),
          );

        const awaitLifecycle = Effect.gen(function* () {
          const barrier = TestVsCode.createTestNotebookDocument(
            `file:///test/lifecycle-barrier-${barrierId++}.py`,
          );
          yield* vscode.openNotebook(barrier);
          yield* vscode.setActiveNotebookEditor(
            Option.some(TestVsCode.createTestNotebookEditor(barrier)),
          );
          yield* awaitActiveDocument(barrier);
        });

        return Service.of({
          first,
          replacement,
          current: Effect.sync(() => sessions.current(id)),
          forDocument: (document) =>
            Effect.sync(() => sessions.forDocument(document)),
          openReplacement: vscode.openNotebook(replacement).pipe(Effect.asVoid),
          closeFirst: vscode.closeNotebook(first),
          closeReplacement: vscode.closeNotebook(replacement),
          replayClosedFirst: vscode
            .closeNotebook(first)
            .pipe(
              Effect.andThen(vscode.openNotebook(first)),
              Effect.andThen(awaitLifecycle),
            ),
          activateFirst: vscode.setActiveNotebookEditor(
            Option.some(TestVsCode.createTestNotebookEditor(first)),
          ),
          activateReplacement: vscode.setActiveNotebookEditor(
            Option.some(TestVsCode.createTestNotebookEditor(replacement)),
          ),
          awaitActive,
          awaitActiveDocument,
          awaitLifecycle,
        });
      }),
    ).pipe(Layer.provide(environment));

    return Layer.merge(environment, fixture);
  });

export const layer = layerWith({ initiallyOpen: true });
