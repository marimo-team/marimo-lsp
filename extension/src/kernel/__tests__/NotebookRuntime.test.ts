import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref, Stream } from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { MarimoApiRequest } from "../../types.ts";
import { NotebookRuntime } from "../NotebookRuntime.ts";

const notebook = notebookId("notebook-a");

const makeTestLayer = Effect.fn(function* (
  options: Parameters<typeof makeTestMarimoClient>[0] = {},
) {
  const vscode = yield* TestVsCode.make();
  return Layer.empty.pipe(
    Layer.provideMerge(NotebookRuntime.Default),
    Layer.provide(makeTestMarimoClient(options)),
    Layer.provide(TestTelemetryLive),
    Layer.provide(TestSentryLive),
    Layer.provide(TestPythonExtension.Default),
    Layer.provideMerge(vscode.layer),
  );
});

it.scoped(
  "returns a stable handle that binds the notebook ID",
  Effect.fn(function* () {
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiRequest>>([]);
    const layer = yield* makeTestLayer({
      execute: (request) =>
        Ref.update(requests, (current) => [...current, request]),
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const first = notebooks.forNotebook(notebook);
      const second = notebooks.forNotebook(notebook);

      expect(first).toBe(second);

      yield* first
        .executeCells({ cellIds: [], codes: [] }, "/usr/bin/python")
        .pipe(Effect.orDie);
      yield* first.interrupt().pipe(Effect.orDie);

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
    const layer = yield* makeTestLayer({
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
