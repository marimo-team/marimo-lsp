import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Ref } from "effect";

import { makeUiElementDispatcher } from "../../kernel/UiElementDispatcher.ts";
import { notebookId, uiElementId } from "../../lib/__tests__/branded.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { UIElementId, UpdateUIElementRequest } from "../../types.ts";

const NOTEBOOK_A = notebookId("notebook-a");
const NOTEBOOK_B = notebookId("notebook-b");
const SLIDER = uiElementId("slider");
const OTHER = uiElementId("other");

function update(
  ...entries: ReadonlyArray<readonly [UIElementId, unknown]>
): UpdateUIElementRequest {
  return {
    objectIds: entries.map(([objectId]) => objectId),
    values: entries.map(([, value]) => value),
  };
}

function asMap(request: UpdateUIElementRequest): Map<UIElementId, unknown> {
  return new Map(
    request.objectIds.map((objectId, index) => [
      objectId,
      request.values[index],
    ]),
  );
}

describe("UiElementDispatcher", () => {
  it.scoped(
    "keeps only the latest pending value while a request is in flight",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();
      const sent = yield* Ref.make<ReadonlyArray<UpdateUIElementRequest>>([]);

      const dispatcher = yield* makeUiElementDispatcher(
        Effect.fn(function* (_notebookId, request) {
          yield* Ref.update(sent, (requests) => [...requests, request]);
          const value = asMap(request).get(SLIDER);
          if (value === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          } else if (value === 3) {
            yield* Deferred.succeed(secondStarted, undefined);
          }
        }),
      );

      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 1]));
      yield* Deferred.await(firstStarted);
      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 2]));
      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 3]));

      assert.deepStrictEqual(
        (yield* Ref.get(sent)).map((request) => asMap(request).get(SLIDER)),
        [1],
      );

      yield* Deferred.succeed(releaseFirst, undefined);
      yield* Deferred.await(secondStarted);

      assert.deepStrictEqual(
        (yield* Ref.get(sent)).map((request) => asMap(request).get(SLIDER)),
        [1, 3],
      );
    }),
  );

  it.scoped(
    "preserves pending updates for different UI elements",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const releaseFirst = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<UpdateUIElementRequest>();

      const dispatcher = yield* makeUiElementDispatcher(
        Effect.fn(function* (_notebookId, request) {
          if (asMap(request).get(SLIDER) === 1) {
            yield* Deferred.succeed(firstStarted, undefined);
            yield* Deferred.await(releaseFirst);
          } else {
            yield* Deferred.succeed(secondStarted, request);
          }
        }),
      );

      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 1]));
      yield* Deferred.await(firstStarted);
      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 2]));
      yield* dispatcher.offer(NOTEBOOK_A, update([OTHER, 9]));
      yield* Deferred.succeed(releaseFirst, undefined);

      assert.deepStrictEqual(
        asMap(yield* Deferred.await(secondStarted)),
        new Map([
          [SLIDER, 2],
          [OTHER, 9],
        ]),
      );
    }),
  );

  it.scoped(
    "does not let one notebook block another",
    Effect.fn(function* () {
      const notebookAStarted = yield* Deferred.make<void>();
      const releaseNotebookA = yield* Deferred.make<void>();
      const notebookBStarted = yield* Deferred.make<void>();

      const dispatcher = yield* makeUiElementDispatcher(
        Effect.fn(function* (notebookId: NotebookId) {
          if (notebookId === NOTEBOOK_A) {
            yield* Deferred.succeed(notebookAStarted, undefined);
            yield* Deferred.await(releaseNotebookA);
          } else {
            yield* Deferred.succeed(notebookBStarted, undefined);
          }
        }),
      );

      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 1]));
      yield* Deferred.await(notebookAStarted);
      yield* dispatcher.offer(NOTEBOOK_B, update([SLIDER, 2]));
      yield* Deferred.await(notebookBStarted);
      yield* Deferred.succeed(releaseNotebookA, undefined);
    }),
  );

  it.scoped(
    "continues with the latest pending value after a send failure",
    Effect.fn(function* () {
      const firstStarted = yield* Deferred.make<void>();
      const secondStarted = yield* Deferred.make<void>();

      const dispatcher = yield* makeUiElementDispatcher(
        (_notebookId, request) => {
          const value = asMap(request).get(SLIDER);
          if (value === 1) {
            return Deferred.succeed(firstStarted, undefined).pipe(
              Effect.andThen(Effect.fail("send failed")),
            );
          }
          return Deferred.succeed(secondStarted, undefined);
        },
      );

      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 1]));
      yield* Deferred.await(firstStarted);
      yield* dispatcher.offer(NOTEBOOK_A, update([SLIDER, 2]));
      yield* Deferred.await(secondStarted);
    }),
  );

  it.scoped(
    "drops empty or misaligned wire requests",
    Effect.fn(function* () {
      const sends = yield* Ref.make(0);
      const dispatcher = yield* makeUiElementDispatcher(() =>
        Ref.update(sends, (n) => n + 1),
      );

      yield* dispatcher.offer(NOTEBOOK_A, { objectIds: [], values: [] });
      yield* dispatcher.offer(NOTEBOOK_A, {
        objectIds: [SLIDER, OTHER],
        values: [1],
      });

      assert.strictEqual(yield* Ref.get(sends), 0);
    }),
  );
});
