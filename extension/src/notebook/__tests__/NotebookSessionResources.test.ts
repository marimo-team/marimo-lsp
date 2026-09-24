import * as Vitest from "@effect/vitest";
import {
  Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
  Stream,
} from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { makeScopedResourceCounter } from "../../__tests__/__utils__/scopedResourceCounter.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import * as NotebookConfiguration from "../../config/NotebookConfiguration.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../NotebookSessionResources.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");

const runtimeLayer = makeTestNotebookRuntime({
  send: () => Effect.die("Unexpected marimo request"),
});
const it = EffectTest.make(
  Layer.empty.pipe(
    Layer.provideMerge(NotebookDocumentSessions.layer),
    Layer.provideMerge(NotebookSessionResources.layer),
    Layer.provide(runtimeLayer),
    Layer.provideMerge(TestVsCode.layer),
  ),
);

const openDocument = Effect.fn(function* () {
  const vscode = yield* TestVsCode.Service;
  const document = TestVsCode.createTestNotebookDocument(
    TestVsCode.Uri.parse(NOTEBOOK_URI),
  );
  yield* vscode.openNotebook(document);
  yield* vscode.setActiveNotebookEditor(
    Option.some(TestVsCode.createTestNotebookEditor(document)),
  );
  const sessions = yield* NotebookDocumentSessions.Service;
  const session = yield* sessions.active.pipe(
    Stream.filter(Option.exists((active) => active.document === document)),
    Stream.runHead,
    Effect.map((active) => Option.getOrThrow(Option.flatten(active))),
  );
  return { document, session, vscode };
});

Vitest.describe("NotebookSessionResources", () => {
  it.effect("interrupts a running program when its session ends", () =>
    Effect.gen(function* () {
      const { document, session, vscode } = yield* openDocument();
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();

      const resources = yield* NotebookSessionResources.Service;

      const running = yield* resources
        .runScoped(
          session,
          NotebookConfiguration.Service.pipe(
            Effect.andThen(
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Effect.never),
                Effect.ensuring(Deferred.succeed(stopped, undefined)),
              ),
            ),
          ),
        )
        .pipe(Scope.provide(session.scope), Effect.forkDetach);
      yield* Deferred.await(started);

      yield* vscode.closeNotebook(document);
      yield* Deferred.await(stopped);
      const exit = yield* Fiber.await(running);
      Vitest.assert(Exit.isFailure(exit));
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      Vitest.assert.instanceOf(
        failure?.error,
        NotebookDocumentSessions.EndedError,
      );
    }),
  );

  it.effect("rejects work admitted after its session ends", () =>
    Effect.gen(function* () {
      const { document, session, vscode } = yield* openDocument();
      const ran = yield* Ref.make(false);

      const resources = yield* NotebookSessionResources.Service;
      const ended = yield* Deferred.make<void>();
      yield* Effect.addFinalizer(() => Deferred.succeed(ended, undefined)).pipe(
        Scope.provide(session.scope),
      );
      yield* vscode.closeNotebook(document);
      yield* Deferred.await(ended);

      const exit = yield* resources
        .runScoped(session, Ref.set(ran, true))
        .pipe(Scope.provide(session.scope), Effect.exit);
      Vitest.assert(Exit.isFailure(exit));
      const failure = exit.cause.reasons.find(Cause.isFailReason);
      Vitest.assert.instanceOf(
        failure?.error,
        NotebookDocumentSessions.EndedError,
      );
      Vitest.expect(yield* Ref.get(ran)).toBe(false);
    }),
  );

  it.effect("releases scoped resources after programs finish", () =>
    Effect.gen(function* () {
      const { session } = yield* openDocument();
      const tracked = yield* makeScopedResourceCounter();

      const resources = yield* NotebookSessionResources.Service;

      const providedScope = yield* resources
        .runScoped(session, Effect.scope)
        .pipe(Scope.provide(session.scope));
      Vitest.expect(providedScope).toBe(session.scope);

      for (let index = 0; index < 100; index++) {
        yield* resources
          .runScoped(session, tracked.track(NotebookConfiguration.Service))
          .pipe(Scope.provide(session.scope));
      }

      Vitest.expect(yield* tracked.counts).toEqual({
        acquired: 100,
        released: 100,
        active: 0,
      });
    }),
  );
});
