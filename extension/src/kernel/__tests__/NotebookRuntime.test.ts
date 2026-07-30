import { assert, expect, it } from "@effect/vitest";
import { Effect, Ref, Stream } from "effect";

import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { MarimoApiRequest } from "../../types.ts";
import { NotebookRuntime } from "../NotebookRuntime.ts";

const notebook = notebookId("notebook-a");

it.scoped(
  "returns a stable handle that binds the notebook ID",
  Effect.fn(function* () {
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiRequest>>([]);
    const layer = makeTestNotebookRuntime({
      execute: (request) =>
        Ref.update(requests, (current) => [...current, request]),
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const first = notebooks.forNotebook(notebook);
      const second = notebooks.forNotebook(notebook);

      expect(first).toBe(second);

      yield* first.executeCells({ cellIds: [], codes: [] }, "/usr/bin/python");
      yield* first.interrupt();

      assert.deepStrictEqual(yield* Ref.get(requests), [
        {
          method: "execute-cells",
          params: {
            notebookUri: notebook,
            executable: "/usr/bin/python",
            inner: { cellIds: [], codes: [] },
          },
        },
        {
          method: "interrupt",
          params: {
            notebookUri: notebook,
            inner: {},
          },
        },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);

it.scoped(
  "subscribes to MarimoClient operations once",
  Effect.fn(function* () {
    let subscriptions = 0;
    const layer = makeTestNotebookRuntime({
      operations: () => {
        subscriptions += 1;
        return Stream.never;
      },
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      notebooks.forNotebook(notebook);
      notebooks.forNotebook(notebookId("notebook-b"));

      expect(subscriptions).toBe(1);
    }).pipe(Effect.provide(layer));
  }),
);
