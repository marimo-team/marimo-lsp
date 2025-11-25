import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, TestClock } from "effect";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import {
  createTestTextDocument,
  createTestTextEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { PythonEnvironmentStatusBarLive } from "../PythonEnvironmentStatusBar.ts";
import { StatusBar } from "../StatusBar.ts";

/**
 * Integration tests for PythonEnvironmentStatusBar.
 *
 * Tests verify that the status bar only appears when appropriate:
 * - Shows when only marimo notebooks are visible
 * - Hides when Python files are also open
 * - Hides when Jupyter notebooks are also open
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
  "should show status bar when only marimo notebook is visible",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;
    yield* Effect.gen(function* () {
      // Create a marimo notebook editor
      const marimoEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook_mo.py",
      );
      yield* ctx.vscode.addNotebookDocument(marimoEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(marimoEditor));

      // Wait for async processing
      yield* TestClock.adjust("10 millis");

      // Status bar should be visible
      const isVisible = yield* Ref.get(ctx.statusBarVisible);
      expect(isVisible).toBe(true);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should hide status bar when Python file is also open",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;

    yield* Effect.gen(function* () {
      // Create a marimo notebook editor
      const marimoEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook_mo.py",
      );
      yield* ctx.vscode.addNotebookDocument(marimoEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(marimoEditor));

      // Also create a Python file editor
      const pythonDoc = createTestTextDocument("/test/script.py", "python", "");
      const pythonEditor = createTestTextEditor(pythonDoc);
      yield* ctx.vscode.setActiveTextEditor(Option.some(pythonEditor));

      // Wait for async processing
      yield* TestClock.adjust("10 millis");

      // Status bar should be hidden
      const isVisible = yield* Ref.get(ctx.statusBarVisible);
      expect(isVisible).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should hide status bar when Jupyter notebook is also open",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;

    yield* Effect.gen(function* () {
      // Create a marimo notebook editor
      const marimoEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook_mo.py",
      );
      yield* ctx.vscode.addNotebookDocument(marimoEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(marimoEditor));

      // Also create a Jupyter notebook editor
      const jupyterEditor = TestVsCode.makeNotebookEditor(
        "/test/notebook.ipynb",
        { notebookType: "jupyter-notebook" },
      );
      yield* ctx.vscode.addNotebookDocument(jupyterEditor.notebook);
      yield* ctx.vscode.setActiveNotebookEditor(Option.some(jupyterEditor));

      // Wait for async processing
      yield* TestClock.adjust("10 millis");

      // Status bar should be hidden
      const isVisible = yield* Ref.get(ctx.statusBarVisible);
      expect(isVisible).toBe(false);
    }).pipe(Effect.provide(ctx.layer));
  }),
);

it.effect(
  "should hide status bar when no marimo notebooks are visible",
  Effect.fnUntraced(function* () {
    const ctx = yield* withTestCtx;

    yield* Effect.gen(function* () {
      yield* TestClock.adjust("10 millis");

      const isVisible = yield* Ref.get(ctx.statusBarVisible);
      expect(isVisible).toBe(false);
    });
  }),
);
