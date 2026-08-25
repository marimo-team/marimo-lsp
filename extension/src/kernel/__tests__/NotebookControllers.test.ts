import { assert, expect, it } from "@effect/vitest";
import type * as py from "@vscode/python-extension";
import { Effect, Fiber, Layer, Option, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";
import type * as vscode from "vscode";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import {
  isPathInsideDirectory,
  NotebookControllersLive,
} from "../../kernel/NotebookControllers.ts";
import { NotebookRuntime } from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import { Constants } from "../../platform/Constants.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import { makeControllerSelectionChanges } from "../ControllerSelectionChanges.ts";

const withTestCtx = Effect.fn(function* (
  options: {
    initialEnvs?: Array<py.ResolvedEnvironment>;
  } = {},
) {
  const vscode = yield* TestVsCode.make();
  const python = yield* TestPythonExtension.make(options.initialEnvs ?? []);
  const runtime = makeTestNotebookRuntime();
  const controllers = NotebookControllersLive.pipe(Layer.provide(runtime));

  const layer = Layer.merge(runtime, controllers).pipe(
    Layer.provide(Constants.layer),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
    Layer.provideMerge(python.layer),
  );

  return { layer, vscode, python };
});

it.effect(
  "registers controllers for the known Python environments",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx({
      initialEnvs: [
        TestPythonExtension.makeVenv("/home/user/.venv/bin/python"),
        TestPythonExtension.makeGlobalEnv("/usr/local/bin/python3.11"),
      ],
    });

    yield* Effect.gen(function* () {
      yield* NotebookRuntime;

      expect((yield* ctx.vscode.snapshot()).controllers).toEqual([
        "marimo-/home/user/.venv/bin/python",
        "marimo-/usr/local/bin/python3.11",
        "marimo-sandbox",
      ]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it("distinguishes uv cache descendants from shared path prefixes", () => {
  expect(
    isPathInsideDirectory(
      "/home/user/.cache/uv/archive-v0/env/bin/python",
      "/home/user/.cache/uv",
    ),
  ).toBe(true);
  expect(
    isPathInsideDirectory(
      "/home/user/.cache/uv-other/bin/python",
      "/home/user/.cache/uv",
    ),
  ).toBe(false);
});

it.effect(
  "attaches VS Code controller selections to the notebook runtime",
  Effect.fn(function* () {
    const executable = "/usr/local/bin/python3.11";
    const ctx = yield* withTestCtx({
      initialEnvs: [TestPythonExtension.makeVenv(executable)],
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

      const initial = yield* notebooks.forNotebook(
        notebookId(editor.notebook.uri.toString()),
      );
      expect(Option.isNone(yield* initial.getController)).toBe(true);

      // No drain before selecting: the controller's selection listener is
      // acquired in the same fiber turn as its creation, so an event fired
      // this early buffers until trackControllerSelections consumes it. This
      // mirrors VS Code restoring a persisted selection right at creation.
      yield* ctx.vscode.selectNotebookController(
        `marimo-${executable}`,
        editor.notebook,
        true,
      );
      yield* TestClock.adjust("10 millis");

      const selectedNotebook = yield* notebooks.forNotebook(
        notebookId(editor.notebook.uri.toString()),
      );
      const selected = yield* selectedNotebook.getController;
      assert(Option.isSome(selected));
      expect(selected.value.id).toBe(`marimo-${executable}`);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "attaches the controller before the first execution",
  Effect.fn(function* () {
    const executable = "/usr/local/bin/python3.11";
    const ctx = yield* withTestCtx({
      initialEnvs: [TestPythonExtension.makeVenv(executable)],
    });
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
      data: {
        cells: [
          {
            kind: 1,
            value: "answer = 42",
            languageId: "mo-python",
            metadata: MarimoNotebookCell.createMetadata({
              marimoRuntime: { stableId: "cell-1" },
            }),
          },
        ],
      },
    });

    yield* Effect.gen(function* () {
      const notebooks = yield* NotebookRuntime;
      const controllers = yield* Ref.get(ctx.vscode.controllers);
      const controller = [...controllers].find(
        (candidate) => candidate.id === `marimo-${executable}`,
      );
      assert(controller !== undefined);

      // Execute immediately, before the asynchronous selection consumer has
      // a chance to observe VS Code's selected-controller event.
      controller.executeHandler(
        [editor.notebook.cellAt(0)],
        editor.notebook,
        controller,
      );

      yield* TestClock.adjust("1 millis");
      const notebook = yield* notebooks.forNotebook(
        notebookId(editor.notebook.uri.toString()),
      );
      const selected = yield* notebook.getController;
      assert(Option.isSome(selected));
      expect(selected.value.id).toBe(`marimo-${executable}`);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "disposes the controller selection listener when its consumer ends",
  Effect.fn(function* () {
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    let emit:
      | ((event: {
          notebook: vscode.NotebookDocument;
          selected: boolean;
        }) => unknown)
      | undefined;
    let disposals = 0;
    const changes = yield* makeControllerSelectionChanges({
      onDidChangeSelectedNotebooks: (listener) => {
        emit = listener;
        return {
          dispose() {
            disposals += 1;
            emit = undefined;
          },
        };
      },
    });

    const consumer = yield* changes.pipe(
      Stream.take(1),
      Stream.runDrain,
      Effect.forkChild,
    );
    emit?.({ notebook: editor.notebook, selected: true });
    yield* Fiber.join(consumer);

    expect(disposals).toBe(1);
    expect(emit).toBeUndefined();
  }),
);

it.effect(
  "adds and removes controllers when Python environments change",
  Effect.fn(function* () {
    const first = TestPythonExtension.makeVenv("/home/user/.venv/bin/python");
    const second = TestPythonExtension.makeGlobalEnv(
      "/usr/local/bin/python3.11",
    );
    const ctx = yield* withTestCtx({ initialEnvs: [first] });

    yield* Effect.gen(function* () {
      yield* NotebookRuntime;

      // Drain once so the forked environmentChanges consumer subscribes to
      // the mock PubSub before we publish; the PubSub has no replay, so an
      // event published before the fork first runs would be silently lost.
      // Production wraps a vscode event listener registered at activation.
      yield* TestClock.adjust("1 millis");

      yield* ctx.python.addEnvironment(second);
      yield* TestClock.adjust("10 millis");
      expect((yield* ctx.vscode.snapshot()).controllers).toEqual([
        "marimo-/home/user/.venv/bin/python",
        "marimo-/usr/local/bin/python3.11",
        "marimo-sandbox",
      ]);

      yield* ctx.python.removeEnvironment(first);
      yield* TestClock.adjust("10 millis");
      expect((yield* ctx.vscode.snapshot()).controllers).toEqual([
        "marimo-/usr/local/bin/python3.11",
        "marimo-sandbox",
      ]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "keeps a selected controller when its Python environment disappears",
  Effect.fn(function* () {
    const executable = "/home/user/.venv/bin/python";
    const environment = TestPythonExtension.makeVenv(executable);
    const ctx = yield* withTestCtx({ initialEnvs: [environment] });

    yield* Effect.gen(function* () {
      yield* NotebookRuntime;
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
      yield* ctx.vscode.addNotebookDocument(editor.notebook);
      // Drain so the selection listener and the environmentChanges consumer
      // (both forked during layer construction) are attached before the mock
      // events below fire; see the comments in the two tests above.
      yield* TestClock.adjust("1 millis");
      yield* ctx.vscode.selectNotebookController(
        `marimo-${executable}`,
        editor.notebook,
        true,
      );
      yield* TestClock.adjust("10 millis");

      yield* ctx.python.removeEnvironment(environment);
      yield* TestClock.adjust("10 millis");

      expect((yield* ctx.vscode.snapshot()).controllers).toContain(
        `marimo-${executable}`,
      );
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "does not set affinity without a script header or adjacent venv",
  Effect.fn(function* () {
    const ctx = yield* withTestCtx({
      initialEnvs: [TestPythonExtension.makeVenv("/usr/local/bin/python3.11")],
    });

    yield* Effect.gen(function* () {
      yield* NotebookRuntime;
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

      yield* ctx.vscode.setActiveNotebookEditor(Option.some(editor));
      yield* TestClock.adjust("100 millis");

      expect(yield* ctx.vscode.getAffinityUpdates()).toEqual([]);
    }).pipe(Effect.provide(ctx.layer));
  }),
);
