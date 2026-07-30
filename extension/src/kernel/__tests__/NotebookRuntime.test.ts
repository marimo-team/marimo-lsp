import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Schedule, Stream } from "effect";

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

const hasKernelContexts = (vscode: TestVsCode) =>
  Effect.map(Ref.get(vscode.executions), (executions) =>
    executions
      .filter(
        (execution) =>
          execution.command === "setContext" &&
          execution.args[0] === "marimo.notebook.hasKernel",
      )
      .map((execution) => execution.args[1]),
  );

/**
 * Retries until the runtime's forked subscribers have caught up, then gives up
 * and returns the last value so a failing assertion reports it.
 */
const eventually = <A>(
  get: Effect.Effect<A>,
  predicate: (value: A) => boolean,
) =>
  Effect.filterOrFail(get, predicate, () => "not settled yet" as const).pipe(
    Effect.retry(Schedule.recurs(100)),
    Effect.orElse(() => get),
  );

it.scoped(
  "reports no kernel for an active notebook with no controller",
  Effect.fn(function* () {
    const { layer, vscode } = yield* makeTestLayer();
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

    yield* Effect.gen(function* () {
      yield* NotebookRuntime;
      yield* Effect.yieldNow();
      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      const contexts = yield* eventually(
        hasKernelContexts(vscode),
        (values) => values.length > 0,
      );
      expect(contexts.at(-1)).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);

it.scoped(
  "releases a notebook's controller when its document closes",
  Effect.fn(function* () {
    const { layer, vscode } = yield* makeTestLayer();
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    const id = notebookId(editor.notebook.uri.toString());
    const controller: NotebookController = {
      id: "marimo-/usr/bin/python",
      createNotebookCellExecution() {
        throw new Error("not used");
      },
      resolveExecutable: () => Effect.succeed("/usr/bin/python"),
    };

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      yield* Effect.yieldNow();
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      yield* notebooks.attachController(id, controller);
      expect((yield* hasKernelContexts(vscode)).at(-1)).toBe(true);

      yield* Effect.yieldNow();
      yield* vscode.closeNotebook(editor.notebook);

      // Pruning treats a controller as dead once no open notebook selects it,
      // so the runtime must stop handing this one out. Re-resolve the handle
      // each attempt: one captured before the close reads the released state.
      const released = yield* eventually(
        Effect.suspend(() => notebooks.forNotebook(id).getController()),
        Option.isNone,
      );
      expect(Option.isNone(released)).toBe(true);
      expect((yield* hasKernelContexts(vscode)).at(-1)).toBe(false);
    }).pipe(Effect.provide(layer));
  }),
);
