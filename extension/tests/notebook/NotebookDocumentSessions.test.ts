import * as Vitest from "@effect/vitest";
import {
  Context,
  Effect,
  Latch,
  Layer,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type * as vscode from "vscode";

import * as NotebookDocumentSessions from "../../src/notebook/NotebookDocumentSessions.ts";
import type { NotebookDocumentSessionId } from "../../src/schemas/SessionIds.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { notebookId } from "../lib/branded.ts";
import * as DocumentLifecycle from "../lib/documentLifecycle.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const uri = VsCodeTest.Uri.parse("file:///test/notebook.py");
const id = notebookId(uri.toString());

/** Two documents at the same URI and the history of active session IDs. */
class Documents extends Context.Service<
  Documents,
  {
    readonly first: vscode.NotebookDocument;
    readonly replacement: vscode.NotebookDocument;
    readonly active: SubscriptionRef.SubscriptionRef<
      ReadonlyArray<NotebookDocumentSessionId | null>
    >;
  }
>()("@marimo/test/NotebookDocumentSessions/Documents") {}

const layerWith = (options: { readonly initiallyOpen: boolean }) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const first = VsCodeTest.createTestNotebookDocument(uri);
      const replacement = VsCodeTest.createTestNotebookDocument(uri);
      const active = yield* SubscriptionRef.make<
        ReadonlyArray<NotebookDocumentSessionId | null>
      >([]);
      const sessionsLayer = NotebookDocumentSessions.layer.pipe(
        Layer.provideMerge(
          VsCodeTest.layerWith({
            initialDocuments: options.initiallyOpen ? [first] : [],
          }),
        ),
      );
      // Record every active-session transition from the moment the layer builds.
      const tracking = Layer.effectDiscard(
        Effect.gen(function* () {
          const sessions = yield* NotebookDocumentSessions.Service;
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
        }),
      ).pipe(Layer.provide(sessionsLayer));
      return Layer.mergeAll(
        sessionsLayer,
        tracking,
        Layer.succeed(Documents, { first, replacement, active }),
      );
    }),
  );

const current = Effect.map(NotebookDocumentSessions.Service, (sessions) =>
  sessions.current(id),
);

const open = (document: vscode.NotebookDocument) =>
  DocumentLifecycle.transition(document, "opened");

const close = (document: vscode.NotebookDocument) =>
  DocumentLifecycle.transition(document, "closed");

const activate = (document: vscode.NotebookDocument) =>
  Effect.flatMap(VsCodeTest.Service, (vscode) =>
    vscode.setActiveNotebookEditor(
      Option.some(VsCodeTest.createTestNotebookEditor(document)),
    ),
  );

/** Waits until the latest observed active session is `sessionId`. */
const awaitActive = (sessionId: NotebookDocumentSessionId | null) =>
  Effect.flatMap(Documents, ({ active }) =>
    SubscriptionRef.changes(active).pipe(
      Stream.filter((observed) => observed.at(-1) === sessionId),
      Stream.runHead,
      Effect.asVoid,
    ),
  );

const awaitActiveDocument = (document: vscode.NotebookDocument) =>
  Effect.flatMap(NotebookDocumentSessions.Service, (sessions) =>
    sessions.active.pipe(
      Stream.filter(Option.exists((session) => session.document === document)),
      Stream.runHead,
      Effect.map((observed) => Option.getOrThrow(Option.flatten(observed))),
    ),
  );

const it = EffectTest.make(layerWith({ initiallyOpen: true }));

it.effect(
  "ends the old session when a document is replaced at the same URI",
  Effect.fn(function* () {
    const { first, replacement } = yield* Documents;
    const firstSession = yield* current;
    Vitest.expect(
      Option.exists(firstSession, (session) => session.document === first),
    ).toBe(true);
    if (Option.isNone(firstSession)) return;

    const firstEnded = yield* Latch.make();
    yield* Effect.addFinalizer(() => firstEnded.open).pipe(
      Scope.provide(firstSession.value.scope),
    );
    yield* open(replacement);
    yield* firstEnded.await;

    const replacementSession = yield* current;
    Vitest.expect(
      Option.exists(
        replacementSession,
        (session) => session.document === replacement,
      ),
    ).toBe(true);
    if (Option.isNone(replacementSession)) return;
    Vitest.expect(replacementSession.value).not.toBe(firstSession.value);

    yield* close(first);
    Vitest.expect(
      Option.exists(
        yield* current,
        (session) => session === replacementSession.value,
      ),
    ).toBe(true);

    const replacementEnded = yield* Latch.make();
    yield* Effect.addFinalizer(() => replacementEnded.open).pipe(
      Scope.provide(replacementSession.value.scope),
    );
    yield* close(replacement);
    yield* replacementEnded.await;
    Vitest.expect(Option.isNone(yield* current)).toBe(true);
  }),
);

it.effect(
  "a document session owns scoped work and finalizers",
  Effect.fn(function* () {
    const { first } = yield* Documents;
    const session = yield* current;
    Vitest.expect(Option.isSome(session)).toBe(true);
    if (Option.isNone(session)) return;

    const backgroundStarted = yield* Latch.make();
    const backgroundStopped = yield* Latch.make();
    const finalized = yield* Latch.make();
    const lateFinalizer = yield* Latch.make();
    const staleBackgroundStarted = yield* Latch.make();

    yield* Effect.addFinalizer(() => finalized.open).pipe(
      Scope.provide(session.value.scope),
    );
    yield* Effect.forkIn(
      backgroundStarted.open.pipe(
        Effect.andThen(Effect.never),
        Effect.ensuring(backgroundStopped.open),
      ),
      session.value.scope,
    );
    yield* backgroundStarted.await;

    yield* close(first);
    yield* backgroundStopped.await;
    yield* finalized.await;

    yield* Effect.addFinalizer(() => lateFinalizer.open).pipe(
      Scope.provide(session.value.scope),
    );
    yield* lateFinalizer.await;
    yield* Effect.forkIn(staleBackgroundStarted.open, session.value.scope);
    Vitest.expect(staleBackgroundStarted.isOpen()).toBe(false);
  }),
);

it.effect(
  "projects the active session across document replacement and close",
  Effect.fn(function* () {
    const { first, replacement } = yield* Documents;
    const firstSession = yield* current;
    Vitest.expect(Option.isSome(firstSession)).toBe(true);
    if (Option.isNone(firstSession)) return;

    yield* activate(first);
    yield* awaitActive(firstSession.value.id);

    yield* open(replacement);
    yield* activate(replacement);
    const replacementSession = yield* awaitActiveDocument(replacement);
    yield* awaitActive(replacementSession.id);

    yield* close(replacement);
    yield* awaitActive(null);
  }),
);

Vitest.describe("when the document starts closed", () => {
  const it = EffectTest.make(layerWith({ initiallyOpen: false }));

  it.effect(
    "ignores a replayed open for a document that already closed",
    Effect.fn(function* () {
      const { first, replacement } = yield* Documents;
      yield* close(first);
      yield* open(first);
      Vitest.expect(Option.isNone(yield* current)).toBe(true);

      yield* open(replacement);
      yield* activate(replacement);
      yield* awaitActiveDocument(replacement);
      Vitest.expect(
        Option.exists(
          yield* current,
          (session) => session.document === replacement,
        ),
      ).toBe(true);
    }),
  );
});
