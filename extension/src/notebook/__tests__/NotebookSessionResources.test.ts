import { assert, describe, expect, it } from "@effect/vitest";
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
} from "effect";

import {
  createTestNotebookDocument,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NotebookConfiguration } from "../../config/NotebookConfiguration.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import {
  NotebookDocumentSessionEndedError,
  NotebookDocumentSessions,
} from "../NotebookDocumentSessions.ts";
import { NotebookSessionResources } from "../NotebookSessionResources.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");

const withTestContext = Effect.fn(function* () {
  const document = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI));
  const vscode = yield* TestVsCode.make({ initialDocuments: [document] });
  const runtime = makeTestNotebookRuntime({
    send: () => Effect.die("Unexpected marimo request"),
  });
  const sessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(vscode.layer),
  );
  const resources = NotebookSessionResources.layer.pipe(Layer.provide(runtime));

  return {
    document,
    vscode,
    layer: Layer.mergeAll(vscode.layer, sessions, resources),
  };
});

describe("NotebookSessionResources", () => {
  it.effect("interrupts a running program when its session ends", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestContext();
      const started = yield* Deferred.make<void>();
      const stopped = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const sessions = yield* NotebookDocumentSessions;
        const resources = yield* NotebookSessionResources;
        const current = sessions.current(NOTEBOOK_URI);
        assert(Option.isSome(current));
        const session = current.value;

        const running = yield* resources
          .runScoped(
            session,
            NotebookConfiguration.pipe(
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

        yield* ctx.vscode.closeNotebook(ctx.document);
        yield* Deferred.await(stopped);
        const exit = yield* Fiber.await(running);
        assert(Exit.isFailure(exit));
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        assert.instanceOf(failure?.error, NotebookDocumentSessionEndedError);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("rejects work admitted after its session ends", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestContext();
      const ran = yield* Ref.make(false);

      yield* Effect.gen(function* () {
        const sessions = yield* NotebookDocumentSessions;
        const resources = yield* NotebookSessionResources;
        const current = sessions.current(NOTEBOOK_URI);
        assert(Option.isSome(current));
        const session = current.value;
        const ended = yield* Deferred.make<void>();
        yield* Effect.addFinalizer(() =>
          Deferred.succeed(ended, undefined),
        ).pipe(Scope.provide(session.scope));
        yield* ctx.vscode.closeNotebook(ctx.document);
        yield* Deferred.await(ended);

        const exit = yield* resources
          .runScoped(session, Ref.set(ran, true))
          .pipe(Scope.provide(session.scope), Effect.exit);
        assert(Exit.isFailure(exit));
        const failure = exit.cause.reasons.find(Cause.isFailReason);
        assert.instanceOf(failure?.error, NotebookDocumentSessionEndedError);
        expect(yield* Ref.get(ran)).toBe(false);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect("releases per-call ownership after programs finish", () =>
    Effect.gen(function* () {
      const ctx = yield* withTestContext();

      yield* Effect.gen(function* () {
        const sessions = yield* NotebookDocumentSessions;
        const resources = yield* NotebookSessionResources;
        const current = sessions.current(NOTEBOOK_URI);
        assert(Option.isSome(current));
        const session = current.value;

        const providedScope = yield* resources
          .runScoped(session, Effect.scope)
          .pipe(Scope.provide(session.scope));
        expect(providedScope).toBe(session.scope);
        const baseline =
          session.scope.state._tag === "Open"
            ? session.scope.state.finalizers.size
            : 0;

        for (let index = 0; index < 100; index++) {
          yield* resources
            .runScoped(session, NotebookConfiguration)
            .pipe(Scope.provide(session.scope));
        }
        yield* Effect.yieldNow;

        const finalizerCount =
          session.scope.state._tag === "Open"
            ? session.scope.state.finalizers.size
            : 0;
        expect(finalizerCount).toBe(baseline);
      }).pipe(Effect.provide(ctx.layer));
    }),
  );
});
