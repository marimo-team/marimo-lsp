import * as Vitest from "@effect/vitest";
import { Effect, Latch, Option, Scope } from "effect";

import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as TestNotebookDocumentSessions from "./TestNotebookDocumentSessions.ts";

const it = EffectTest.make(TestNotebookDocumentSessions.layer);
const initiallyClosedIt = EffectTest.make(
  TestNotebookDocumentSessions.layerWith({ initiallyOpen: false }),
);

it.effect(
  "ends the old session when a document is replaced at the same URI",
  Effect.fn(function* () {
    const sessions = yield* TestNotebookDocumentSessions.Service;
    const firstSession = yield* sessions.current;
    Vitest.expect(
      Option.exists(
        firstSession,
        (session) => session.document === sessions.first,
      ),
    ).toBe(true);
    if (Option.isNone(firstSession)) return;

    const firstEnded = yield* Latch.make();
    yield* Effect.addFinalizer(() => firstEnded.open).pipe(
      Scope.provide(firstSession.value.scope),
    );
    yield* sessions.openReplacement;
    yield* firstEnded.await;

    const replacementSession = yield* sessions.current;
    Vitest.expect(
      Option.exists(
        replacementSession,
        (session) => session.document === sessions.replacement,
      ),
    ).toBe(true);
    if (Option.isNone(replacementSession)) return;
    Vitest.expect(replacementSession.value).not.toBe(firstSession.value);

    yield* sessions.closeFirst;
    yield* Effect.yieldNow;
    Vitest.expect(
      Option.exists(
        yield* sessions.current,
        (session) => session === replacementSession.value,
      ),
    ).toBe(true);

    const replacementEnded = yield* Latch.make();
    yield* Effect.addFinalizer(() => replacementEnded.open).pipe(
      Scope.provide(replacementSession.value.scope),
    );
    yield* sessions.closeReplacement;
    yield* replacementEnded.await;
    Vitest.expect(Option.isNone(yield* sessions.current)).toBe(true);
  }),
);

initiallyClosedIt.effect(
  "ignores a replayed open for a document that already closed",
  Effect.fn(function* () {
    const sessions = yield* TestNotebookDocumentSessions.Service;
    yield* sessions.replayClosedFirst;
    Vitest.expect(Option.isNone(yield* sessions.current)).toBe(true);

    yield* sessions.openReplacement;
    yield* Effect.yieldNow;
    Vitest.expect(
      Option.exists(
        yield* sessions.current,
        (session) => session.document === sessions.replacement,
      ),
    ).toBe(true);
  }),
);

it.effect(
  "a document session owns scoped work and finalizers",
  Effect.fn(function* () {
    const sessions = yield* TestNotebookDocumentSessions.Service;
    const session = yield* sessions.current;
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

    yield* sessions.closeFirst;
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
    const sessions = yield* TestNotebookDocumentSessions.Service;
    const firstSession = yield* sessions.current;
    Vitest.expect(Option.isSome(firstSession)).toBe(true);
    if (Option.isNone(firstSession)) return;

    yield* sessions.activateFirst;
    yield* sessions.awaitActive(firstSession.value.id);

    yield* sessions.openReplacement;
    yield* Effect.yieldNow;
    const replacementSession = yield* sessions.forDocument(
      sessions.replacement,
    );
    Vitest.expect(Option.isSome(replacementSession)).toBe(true);
    if (Option.isNone(replacementSession)) return;

    yield* sessions.activateReplacement;
    yield* sessions.awaitActive(replacementSession.value.id);

    yield* sessions.closeReplacement;
    yield* sessions.awaitActive(null);
  }),
);
