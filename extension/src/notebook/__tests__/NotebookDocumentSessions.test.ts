import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Layer, Option, Ref, Scope, Stream } from "effect";

import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import {
  type NotebookDocumentSessionId,
  NotebookDocumentSessions,
} from "../NotebookDocumentSessions.ts";

it.effect(
  "ends the old session when a document is replaced at the same URI",
  Effect.fn(function* () {
    const uri = Uri.parse("file:///test/notebook.py");
    const id = notebookId(uri.toString());
    const first = createTestNotebookDocument(uri);
    const replacement = createTestNotebookDocument(uri);
    const vscode = yield* TestVsCode.make({ initialDocuments: [first] });
    const layer = NotebookDocumentSessions.layer.pipe(
      Layer.provideMerge(vscode.layer),
    );

    yield* Effect.gen(function* () {
      const sessions = yield* NotebookDocumentSessions;
      const firstSession = sessions.current(id);
      expect(
        Option.exists(firstSession, (session) => session.document === first),
      ).toBe(true);
      if (Option.isNone(firstSession)) return;

      const firstEnded = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(firstEnded, undefined),
      ).pipe(Scope.provide(firstSession.value.scope));
      yield* vscode.openNotebook(replacement);
      yield* Deferred.await(firstEnded);

      const replacementSession = sessions.current(id);
      expect(
        Option.exists(
          replacementSession,
          (session) => session.document === replacement,
        ),
      ).toBe(true);
      if (Option.isNone(replacementSession)) return;
      expect(replacementSession.value).not.toBe(firstSession.value);

      // A delayed close for the displaced document cannot end its replacement.
      yield* vscode.closeNotebook(first);
      yield* Effect.yieldNow;
      expect(
        Option.exists(
          sessions.current(id),
          (session) => session === replacementSession.value,
        ),
      ).toBe(true);

      const replacementEnded = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() =>
        Deferred.succeed(replacementEnded, undefined),
      ).pipe(Scope.provide(replacementSession.value.scope));
      yield* vscode.closeNotebook(replacement);
      yield* Deferred.await(replacementEnded);
      expect(Option.isNone(sessions.current(id))).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "ignores a replayed open for a document that already closed",
  Effect.fn(function* () {
    const uri = Uri.parse("file:///test/notebook.py");
    const id = notebookId(uri.toString());
    const first = createTestNotebookDocument(uri);
    const replacement = createTestNotebookDocument(uri);
    const vscode = yield* TestVsCode.make();
    // The lifecycle snapshot can hold a document that closes before the
    // consumer observes its open. Model that stale entry directly.
    yield* vscode.closeNotebook(first);
    yield* vscode.addNotebookDocument(first);
    const layer = NotebookDocumentSessions.layer.pipe(
      Layer.provideMerge(vscode.layer),
    );

    yield* Effect.gen(function* () {
      const sessions = yield* NotebookDocumentSessions;
      expect(Option.isNone(sessions.current(id))).toBe(true);

      yield* vscode.openNotebook(replacement);
      yield* Effect.yieldNow;
      expect(
        Option.exists(
          sessions.current(id),
          (session) => session.document === replacement,
        ),
      ).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "a document session owns scoped work and finalizers",
  Effect.fn(function* () {
    const uri = Uri.parse("file:///test/notebook.py");
    const id = notebookId(uri.toString());
    const document = createTestNotebookDocument(uri);
    const vscode = yield* TestVsCode.make({ initialDocuments: [document] });
    const layer = NotebookDocumentSessions.layer.pipe(
      Layer.provideMerge(vscode.layer),
    );
    const backgroundStarted = yield* Deferred.make<void>();
    const backgroundStopped = yield* Deferred.make<void>();
    const finalized = yield* Deferred.make<void>();
    const lateFinalizer = yield* Deferred.make<void>();
    const staleBackgroundStarted = yield* Deferred.make<void>();

    yield* Effect.gen(function* () {
      const sessions = yield* NotebookDocumentSessions;
      const session = sessions.current(id);
      expect(Option.isSome(session)).toBe(true);
      if (Option.isNone(session)) return;

      yield* Effect.addFinalizer(() =>
        Deferred.succeed(finalized, undefined),
      ).pipe(Scope.provide(session.value.scope));
      yield* Effect.forkIn(
        Deferred.succeed(backgroundStarted, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(backgroundStopped, undefined)),
        ),
        session.value.scope,
      );
      yield* Deferred.await(backgroundStarted);

      yield* vscode.closeNotebook(document);
      yield* Deferred.await(backgroundStopped);
      yield* Deferred.await(finalized);

      yield* Effect.addFinalizer(() =>
        Deferred.succeed(lateFinalizer, undefined),
      ).pipe(Scope.provide(session.value.scope));
      yield* Deferred.await(lateFinalizer);
      yield* Effect.forkIn(
        Deferred.succeed(staleBackgroundStarted, undefined),
        session.value.scope,
      );
      expect(Option.isNone(yield* Deferred.poll(staleBackgroundStarted))).toBe(
        true,
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "projects the active session across document replacement and close",
  Effect.fn(function* () {
    const uri = Uri.parse("file:///test/notebook.py");
    const id = notebookId(uri.toString());
    const first = createTestNotebookDocument(uri);
    const replacement = createTestNotebookDocument(uri);
    const vscode = yield* TestVsCode.make({ initialDocuments: [first] });
    const layer = NotebookDocumentSessions.layer.pipe(
      Layer.provideMerge(vscode.layer),
    );

    yield* Effect.gen(function* () {
      const sessions = yield* NotebookDocumentSessions;
      const firstSession = sessions.current(id);
      expect(Option.isSome(firstSession)).toBe(true);
      if (Option.isNone(firstSession)) return;

      const observed = yield* Ref.make<
        ReadonlyArray<NotebookDocumentSessionId | null>
      >([]);
      yield* sessions.active.pipe(
        Stream.runForEach((active) =>
          Ref.update(observed, (sessions) => [
            ...sessions,
            Option.match(active, {
              onNone: () => null,
              onSome: (session) => session.id,
            }),
          ]),
        ),
        Effect.forkChild,
      );

      yield* vscode.setActiveNotebookEditor(
        Option.some(createTestNotebookEditor(first)),
      );
      yield* Ref.get(observed).pipe(
        Effect.filterOrFail(
          (sessions) => sessions.includes(firstSession.value.id),
          () => "first session not observed" as const,
        ),
        Effect.eventually,
      );

      yield* vscode.openNotebook(replacement);
      const replacementSession = yield* Effect.sync(() =>
        sessions.forDocument(replacement),
      ).pipe(
        Effect.filterOrFail(
          Option.isSome,
          () => "replacement session not opened" as const,
        ),
        Effect.eventually,
        Effect.map((session) => session.value),
      );
      yield* vscode.setActiveNotebookEditor(
        Option.some(createTestNotebookEditor(replacement)),
      );
      yield* Ref.get(observed).pipe(
        Effect.filterOrFail(
          (sessions) => sessions.includes(replacementSession.id),
          () => "replacement session not observed" as const,
        ),
        Effect.eventually,
      );

      yield* vscode.closeNotebook(replacement);
      yield* Ref.get(observed).pipe(
        Effect.filterOrFail(
          (sessions) => sessions.at(-1) === null,
          () => "closed session remained active" as const,
        ),
        Effect.eventually,
      );
    }).pipe(Effect.provide(layer));
  }),
);
