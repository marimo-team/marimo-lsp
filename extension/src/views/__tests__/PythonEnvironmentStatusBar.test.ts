import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, TestClock } from "effect";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { PythonEnvironmentStatusBarLive } from "../PythonEnvironmentStatusBar.ts";
import { StatusBar } from "../StatusBar.ts";

/**
 * Integration tests for PythonEnvironmentStatusBar.
 *
 * The status bar shows when a marimo notebook is the active notebook editor.
 * It respects the Python extension's `python.interpreter.infoVisibility` setting:
 * - "always" or "never": We never show (defer to user preference)
 * - "onPythonRelated" (default): We show when marimo notebook is active
 */

const withTestCtx = Effect.gen(function* () {
  const vscode = yield* TestVsCode.make();
  const pythonExt = yield* TestPythonExtension.make([
    TestPythonExtension.makeGlobalEnv("/usr/bin/python3"),
  ]);

  const visible = yield* Ref.make(false);
  const statusBarLayer = Layer.succeed(
    StatusBar,
    StatusBar.make({
      createSimpleStatusBarItem() {
        return Effect.die("Not implemented in test");
      },
      createStatusBarItem: () =>
        Effect.succeed({
          setText: () => Effect.void,
          setTooltip: () => Effect.void,
          setColor: () => Effect.void,
          setBackgroundColor: () => Effect.void,
          setCommand: () => Effect.void,
          show: () => Ref.set(visible, true),
          hide: () => Ref.set(visible, false),
        }),
    }),
  );

  return {
    vscode,
    statusBarVisible: visible,
    layer: PythonEnvironmentStatusBarLive.pipe(
      Layer.provide(vscode.layer),
      Layer.provide(pythonExt.layer),
      Layer.provide(statusBarLayer),
    ),
  };
});

it.scoped(
  "should show status bar when marimo notebook is active",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;
    yield* Effect.gen(function* () {
      const marimoEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook_mo.py",
      );
      yield* ctx.vscode.addNotebookDocument(marimoEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(marimoEditor));

      yield* TestClock.adjust("10 millis");

      const isVisible = yield* Ref.get(ctx.statusBarVisible);
      expect(isVisible).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.scoped(
  "should hide status bar when Jupyter notebook becomes active",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;
    yield* Effect.gen(function* () {
      // Start with marimo notebook active
      const marimoEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook_mo.py",
      );
      yield* ctx.vscode.addNotebookDocument(marimoEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(marimoEditor));

      yield* TestClock.adjust("10 millis");
      expect(yield* Ref.get(ctx.statusBarVisible)).toBe(true);

      // Switch to Jupyter notebook
      const jupyterEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook.ipynb",
        {
          notebookType: "jupyter-notebook",
        },
      );
      yield* ctx.vscode.addNotebookDocument(jupyterEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(jupyterEditor));

      yield* TestClock.adjust("10 millis");
      expect(yield* Ref.get(ctx.statusBarVisible)).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.scoped(
  "should hide status bar when no notebook is active",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;
    yield* Effect.gen(function* () {
      // Start with marimo notebook active
      const marimoEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook_mo.py",
      );
      yield* ctx.vscode.addNotebookDocument(marimoEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(marimoEditor));

      yield* TestClock.adjust("10 millis");
      expect(yield* Ref.get(ctx.statusBarVisible)).toBe(true);

      // Switch to no active notebook (e.g., user opens a text file)
      yield* ctx.vscode.setActiveNotebookEditor(Option.none());

      yield* TestClock.adjust("10 millis");
      expect(yield* Ref.get(ctx.statusBarVisible)).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.scoped(
  "should hide status bar initially when no marimo notebook is open",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;
    yield* Effect.gen(function* () {
      yield* TestClock.adjust("10 millis");

      const isVisible = yield* Ref.get(ctx.statusBarVisible);
      expect(isVisible).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);
