import * as Vitest from "@effect/vitest";
import {
  Context,
  Effect,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";

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

/** Visibility of the single status bar item created by the feature. */
class Visibility extends Context.Service<
  Visibility,
  {
    readonly current: Effect.Effect<boolean>;
    readonly await: (visible: boolean) => Effect.Effect<void>;
  }
>()("@marimo/test/PythonEnvironmentStatusBar/Visibility") {}

const statusBarLayer = Layer.unwrap(
  Effect.map(SubscriptionRef.make(false), (visible) =>
    Layer.merge(
      Layer.mock(StatusBar.Service, {
        createStatusBarItem: () =>
          Effect.succeed({
            setText: () => Effect.void,
            setTooltip: () => Effect.void,
            setColor: () => Effect.void,
            setBackgroundColor: () => Effect.void,
            setCommand: () => Effect.void,
            show: SubscriptionRef.set(visible, true),
            hide: SubscriptionRef.set(visible, false),
          }),
      }),
      Layer.succeed(Visibility, {
        current: SubscriptionRef.get(visible),
        await: (expected) =>
          SubscriptionRef.changes(visible).pipe(
            Stream.filter((current) => current === expected),
            Stream.runHead,
            Effect.asVoid,
          ),
      }),
    ),
  ),
);

const it = EffectTest.make(
  PythonEnvironmentStatusBar.layer.pipe(
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
    const visibility = yield* Visibility;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* visibility.await(true);
    Vitest.expect(yield* visibility.current).toBe(true);
  }),
);

it.effect(
  "should hide status bar when Jupyter notebook becomes active",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const visibility = yield* Visibility;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* visibility.await(true);
    Vitest.expect(yield* visibility.current).toBe(true);

    const jupyterEditor = TestVsCode.makeNotebookEditor(
      "/test/notebook.ipynb",
      { notebookType: "jupyter-notebook" },
    );
    yield* vscode.openNotebook(jupyterEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(jupyterEditor));

    yield* visibility.await(false);
    Vitest.expect(yield* visibility.current).toBe(false);
  }),
);

it.effect(
  "should hide status bar when no notebook is active",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const visibility = yield* Visibility;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* visibility.await(true);
    Vitest.expect(yield* visibility.current).toBe(true);

    yield* vscode.setActiveNotebookEditor(Option.none());

    yield* visibility.await(false);
    Vitest.expect(yield* visibility.current).toBe(false);
  }),
);

it.effect(
  "should hide status bar initially when no marimo notebook is open",
  Effect.fn(function* () {
    const visibility = yield* Visibility;
    Vitest.expect(yield* visibility.current).toBe(false);
  }),
);
