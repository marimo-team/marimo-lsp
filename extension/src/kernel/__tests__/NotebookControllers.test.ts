import { assert, expect, it } from "@effect/vitest";
import type * as py from "@vscode/python-extension";
import { Effect, Layer, Option, TestClock } from "effect";

import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestSentryLive } from "../../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NotebookControllersLive } from "../../kernel/NotebookControllers.ts";
import { NotebookRuntime } from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import { Constants } from "../../platform/Constants.ts";

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
    Layer.provide(Constants.Default),
    Layer.provide(TestTelemetryLive),
    Layer.provide(TestSentryLive),
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

      expect(
        Option.isNone(
          yield* notebooks
            .forNotebook(notebookId(editor.notebook.uri.toString()))
            .getController(),
        ),
      ).toBe(true);

      yield* ctx.vscode.selectNotebookController(
        `marimo-${executable}`,
        editor.notebook,
        true,
      );
      yield* TestClock.adjust("10 millis");

      const selected = yield* notebooks
        .forNotebook(notebookId(editor.notebook.uri.toString()))
        .getController();
      assert(Option.isSome(selected));
      expect(selected.value.id).toBe(`marimo-${executable}`);
    }).pipe(Effect.provide(ctx.layer));
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
