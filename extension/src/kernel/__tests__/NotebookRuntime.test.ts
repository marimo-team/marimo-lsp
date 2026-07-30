import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { MarimoApiRequest } from "../../types.ts";
import {
  type NotebookController,
  NotebookRuntime,
} from "../NotebookRuntime.ts";

const notebook = notebookId("notebook-a");

const makeTestLayer = Effect.fn(function* (
  options: Parameters<typeof makeTestMarimoClient>[0] = {},
) {
  const vscode = yield* TestVsCode.make();
  return {
    vscode,
    layer: Layer.empty.pipe(
      Layer.provideMerge(NotebookRuntime.Default),
      Layer.provide(makeTestMarimoClient(options)),
      Layer.provide(TestTelemetryLive),
      Layer.provide(TestSentryLive),
      Layer.provide(TestPythonExtension.Default),
      Layer.provideMerge(vscode.layer),
    ),
  };
});

it.scoped(
  "returns a stable handle that binds the notebook ID",
  Effect.fn(function* () {
    const requests = yield* Ref.make<ReadonlyArray<MarimoApiRequest>>([]);
    const { layer } = yield* makeTestLayer({
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
    const { layer } = yield* makeTestLayer({
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

it.scoped(
  "owns the selected controller",
  Effect.fn(function* () {
    const { layer } = yield* makeTestLayer();
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      createNotebookCellExecution() {
        throw new Error("not used");
      },
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const handle = notebooks.forNotebook(notebook);

      expect(Option.isNone(yield* handle.getController())).toBe(true);
      yield* notebooks.attachController(notebook, controller);

      expect(yield* handle.getController()).toEqual(Option.some(controller));
    }).pipe(Effect.provide(layer));
  }),
);

it.scoped(
  "updates the active notebook kernel context when a controller is attached",
  Effect.fn(function* () {
    const { layer, vscode } = yield* makeTestLayer();
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      createNotebookCellExecution() {
        throw new Error("not used");
      },
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* notebooks.attachController(
        notebookId(editor.notebook.uri.toString()),
        controller,
      );

      const contexts = (yield* Ref.get(vscode.executions)).filter(
        (execution) =>
          execution.command === "setContext" &&
          execution.args[0] === "marimo.notebook.hasKernel",
      );
      expect(contexts.at(-1)?.args[1]).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);
