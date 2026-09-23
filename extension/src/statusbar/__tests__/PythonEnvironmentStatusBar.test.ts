import { expect } from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref } from "effect";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as PythonEnvironmentStatusBar from "../PythonEnvironmentStatusBar.ts";
import * as StatusBar from "../StatusBar.ts";

/**
 * Integration tests for PythonEnvironmentStatusBar.
 *
 * The status bar shows when a marimo notebook is the active notebook editor.
 * It respects the Python extension's `python.interpreter.infoVisibility` setting:
 * - "always" or "never": We never show (defer to user preference)
 * - "onPythonRelated" (default): We show when marimo notebook is active
 */

interface TestStatusBarInterface {
  readonly visible: Effect.Effect<boolean>;
}

class TestStatusBar extends Context.Service<
  TestStatusBar,
  TestStatusBarInterface
>()("@marimo/test/StatusBar") {}

const statusBarLayer = Layer.unwrap(
  Ref.make(false).pipe(
    Effect.map((visible) =>
      Layer.merge(
        Layer.mock(StatusBar.Service, {
          createStatusBarItem: () =>
            Effect.succeed({
              setText: () => Effect.void,
              setTooltip: () => Effect.void,
              setColor: () => Effect.void,
              setBackgroundColor: () => Effect.void,
              setCommand: () => Effect.void,
              show: Ref.set(visible, true),
              hide: Ref.set(visible, false),
            }),
        }),
        Layer.succeed(TestStatusBar, { visible: Ref.get(visible) }),
      ),
    ),
  ),
);

const it = EffectTest.make(
  Layer.empty.pipe(
    Layer.provideMerge(PythonEnvironmentStatusBar.layer),
    Layer.provideMerge(statusBarLayer),
    Layer.provide(
      TestPythonExtension.layerWith([
        TestPythonExtension.makeGlobalEnv("/usr/bin/python3"),
      ]),
    ),
    Layer.provideMerge(TestVsCode.layer),
  ),
);

it.effect(
  "should show status bar when marimo notebook is active",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const statusBar = yield* TestStatusBar;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* Effect.yieldNow;
    expect(yield* statusBar.visible).toBe(true);
  }),
);

it.effect(
  "should hide status bar when Jupyter notebook becomes active",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const statusBar = yield* TestStatusBar;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* Effect.yieldNow;
    expect(yield* statusBar.visible).toBe(true);

    const jupyterEditor = TestVsCode.makeNotebookEditor(
      "/test/notebook.ipynb",
      { notebookType: "jupyter-notebook" },
    );
    yield* vscode.openNotebook(jupyterEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(jupyterEditor));

    yield* Effect.yieldNow;
    expect(yield* statusBar.visible).toBe(false);
  }),
);

it.effect(
  "should hide status bar when no notebook is active",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const statusBar = yield* TestStatusBar;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* Effect.yieldNow;
    expect(yield* statusBar.visible).toBe(true);

    yield* vscode.setActiveNotebookEditor(Option.none());

    yield* Effect.yieldNow;
    expect(yield* statusBar.visible).toBe(false);
  }),
);

it.effect(
  "should hide status bar initially when no marimo notebook is open",
  Effect.fn(function* () {
    const statusBar = yield* TestStatusBar;
    yield* Effect.yieldNow;
    expect(yield* statusBar.visible).toBe(false);
  }),
);
