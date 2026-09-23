import * as Vitest from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Scope, Stream } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import {
  marimoConfigFixture,
  notebookId,
} from "../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../../notebook/NotebookSessionResources.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import * as NotebookConfiguration from "../NotebookConfiguration.ts";
import * as TestNotebookConfiguration from "./TestNotebookConfiguration.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const NOTEBOOK_URI_1 = notebookId("file:///test/notebook1.py");
const NOTEBOOK_URI_2 = notebookId("file:///test/notebook2.py");

const AUTORUN_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "autorun" },
});
const LAZY_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "lazy" },
});
const AUTO_RELOAD_CONFIG = marimoConfigFixture({
  runtime: { on_cell_change: "autorun", auto_reload: "autorun" },
});

const it = EffectTest.make(
  TestNotebookConfiguration.layerWith(
    new Map([
      [NOTEBOOK_URI, AUTORUN_CONFIG],
      [NOTEBOOK_URI_1, AUTORUN_CONFIG],
      [NOTEBOOK_URI_2, AUTO_RELOAD_CONFIG],
    ]),
  ),
);

const inNotebook = <A, E, R>(
  notebookUri: NotebookId,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sessions = yield* NotebookDocumentSessions.Service;
    const resources = yield* NotebookSessionResources.Service;
    const session = sessions.current(notebookUri);
    Vitest.assert(Option.isSome(session));
    return yield* resources
      .runScoped(session.value, effect)
      .pipe(Scope.provide(session.value.scope));
  });

const getConfig = (notebookUri: NotebookId) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.Service.pipe(
      Effect.flatMap((configuration) => configuration.get),
    ),
  );

const updateConfig = (
  notebookUri: NotebookId,
  partialConfig: Record<string, unknown>,
) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.Service.pipe(
      Effect.flatMap((configuration) => configuration.update(partialConfig)),
    ),
  );

const invalidateConfig = (notebookUri: NotebookId) =>
  inNotebook(
    notebookUri,
    NotebookConfiguration.Service.pipe(
      Effect.flatMap((configuration) => configuration.invalidate),
    ),
  );

const configurationChanges = (
  notebookUri: NotebookId,
  take: number,
  ready: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    const sessions = yield* NotebookDocumentSessions.Service;
    const resources = yield* NotebookSessionResources.Service;
    const session = sessions.current(notebookUri);
    Vitest.assert(Option.isSome(session));
    return yield* resources
      .runScoped(
        session.value,
        NotebookConfiguration.Service.pipe(
          Effect.flatMap((configuration) =>
            configuration.changes.pipe(
              Stream.tap((value) =>
                Option.isSome(value)
                  ? Deferred.succeed(ready, undefined)
                  : Effect.void,
              ),
              Stream.take(take),
              Stream.runCollect,
            ),
          ),
        ),
      )
      .pipe(Scope.provide(session.value.scope));
  });

const requestCount = Effect.fn(function* (kind: string) {
  const test = yield* TestNotebookConfiguration.Service;
  return (yield* test.requests).filter((request) => request.kind === kind)
    .length;
});

Vitest.describe("NotebookConfiguration", () => {
  it.effect(
    "fetches once and caches within a document session",
    Effect.fn(function* () {
      const test = yield* TestNotebookConfiguration.Service;

      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
      yield* test.setConfig(NOTEBOOK_URI, marimoConfigFixture({}));
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
    }),
  );

  it.effect(
    "shares an in-flight lookup",
    Effect.fn(function* () {
      const test = yield* TestNotebookConfiguration.Service;
      const pause = yield* test.pauseNextGet;
      const lookups = yield* Effect.forkChild(
        Effect.all([getConfig(NOTEBOOK_URI), getConfig(NOTEBOOK_URI)], {
          concurrency: "unbounded",
        }),
      );

      yield* pause.started;
      Vitest.expect(yield* requestCount("get-configuration")).toBe(1);
      yield* pause.release;
      Vitest.expect(yield* Fiber.join(lookups)).toEqual([
        AUTORUN_CONFIG,
        AUTORUN_CONFIG,
      ]);
    }),
  );

  it.effect(
    "updates the cached value and publishes changes",
    Effect.fn(function* () {
      const ready = yield* Deferred.make<void>();
      const collected = yield* Effect.forkChild(
        configurationChanges(NOTEBOOK_URI, 4, ready),
      );
      yield* Deferred.await(ready);

      yield* updateConfig(NOTEBOOK_URI, {
        runtime: { on_cell_change: "lazy" },
      });
      yield* updateConfig(NOTEBOOK_URI, {
        runtime: { on_cell_change: "autorun" },
      });

      const changes = yield* Fiber.join(collected);
      Vitest.expect(changes[0]?._tag).toBe("None");
      Vitest.expect(changes[1]).toEqual(Option.some(AUTORUN_CONFIG));
      Vitest.expect(changes[2]).toEqual(Option.some(LAZY_CONFIG));
      Vitest.expect(changes[3]).toEqual(Option.some(AUTORUN_CONFIG));
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);
    }),
  );

  it.effect(
    "does not publish a lookup superseded by an update",
    Effect.fn(function* () {
      const test = yield* TestNotebookConfiguration.Service;
      const pause = yield* test.pauseNextGet;

      yield* inNotebook(
        NOTEBOOK_URI,
        NotebookConfiguration.Service.pipe(
          Effect.flatMap((configuration) =>
            Effect.gen(function* () {
              const stale = yield* configuration.get.pipe(Effect.forkChild);
              yield* pause.started;

              Vitest.expect(
                yield* configuration.update({
                  runtime: { on_cell_change: "lazy" },
                }),
              ).toEqual(LAZY_CONFIG);
              yield* pause.release;
              Vitest.expect(yield* Fiber.join(stale)).toEqual(AUTORUN_CONFIG);

              const current = yield* configuration.changes.pipe(
                Stream.take(1),
                Stream.runHead,
              );
              Vitest.expect(Option.getOrThrow(current)).toEqual(
                Option.some(LAZY_CONFIG),
              );
              Vitest.expect(yield* configuration.get).toEqual(LAZY_CONFIG);
            }),
          ),
        ),
      );
    }),
  );

  it.effect(
    "serializes configuration updates",
    Effect.fn(function* () {
      const test = yield* TestNotebookConfiguration.Service;
      const pause = yield* test.pauseNextUpdate;
      const first = yield* updateConfig(NOTEBOOK_URI, {
        runtime: { on_cell_change: "lazy" },
      }).pipe(Effect.forkChild);
      yield* pause.started;
      const second = yield* updateConfig(NOTEBOOK_URI, {
        runtime: {
          on_cell_change: "autorun",
          auto_reload: "autorun",
        },
      }).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      Vitest.expect(yield* requestCount("update-configuration")).toBe(1);

      yield* pause.release;
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      Vitest.expect(yield* requestCount("update-configuration")).toBe(2);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTO_RELOAD_CONFIG);
    }),
  );

  it.effect(
    "does not recache a lookup invalidated while in flight",
    Effect.fn(function* () {
      const test = yield* TestNotebookConfiguration.Service;
      const pause = yield* test.pauseNextGet;
      const pending = yield* Effect.forkChild(getConfig(NOTEBOOK_URI));
      yield* pause.started;
      yield* invalidateConfig(NOTEBOOK_URI);
      yield* test.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
      yield* pause.release;

      Vitest.expect(yield* Fiber.join(pending)).toEqual(AUTORUN_CONFIG);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
    }),
  );

  it.effect(
    "evicts resources when a document session ends",
    Effect.fn(function* () {
      const test = yield* TestNotebookConfiguration.Service;
      const document = Option.getOrThrow(test.document(NOTEBOOK_URI));
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);

      yield* test.vscode.closeNotebook(document);
      yield* test.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
      const replacement = TestVsCode.createTestNotebookDocument(
        TestVsCode.Uri.parse(NOTEBOOK_URI),
      );
      yield* test.vscode.openNotebook(replacement);
      yield* Effect.yieldNow;

      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
    }),
  );

  it.effect(
    "ignores a delayed close from a replaced document",
    Effect.fn(function* () {
      const test = yield* TestNotebookConfiguration.Service;
      const first = Option.getOrThrow(test.document(NOTEBOOK_URI));
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(AUTORUN_CONFIG);

      yield* test.setConfig(NOTEBOOK_URI, LAZY_CONFIG);
      const replacement = TestVsCode.createTestNotebookDocument(
        TestVsCode.Uri.parse(NOTEBOOK_URI),
      );
      yield* test.vscode.openNotebook(replacement);
      yield* Effect.yieldNow;
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);

      yield* test.setConfig(NOTEBOOK_URI, AUTORUN_CONFIG);
      yield* test.vscode.closeNotebook(first);
      yield* Effect.yieldNow;
      Vitest.expect(yield* getConfig(NOTEBOOK_URI)).toEqual(LAZY_CONFIG);
    }),
  );

  it.effect(
    "isolates concurrent notebook sessions",
    Effect.fn(function* () {
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_1)).toEqual(AUTORUN_CONFIG);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_2)).toEqual(
        AUTO_RELOAD_CONFIG,
      );

      yield* updateConfig(NOTEBOOK_URI_1, {
        runtime: { on_cell_change: "lazy" },
      });
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_1)).toEqual(LAZY_CONFIG);
      Vitest.expect(yield* getConfig(NOTEBOOK_URI_2)).toEqual(
        AUTO_RELOAD_CONFIG,
      );
    }),
  );
});
