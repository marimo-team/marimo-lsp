import * as Vitest from "@effect/vitest";
import {
  Context,
  Effect,
  Layer,
  Option,
  Stream,
  SubscriptionRef,
} from "effect";

import * as PythonEnvironmentStatusBar from "../../src/statusbar/PythonEnvironmentStatusBar.ts";
import * as StatusBar from "../../src/statusbar/StatusBar.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

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
      PythonExtensionTest.layerWith([
        PythonExtensionTest.makeGlobalEnv("/usr/bin/python3"),
      ]),
    ),
    Layer.provideMerge(VsCodeTest.layer),
  ),
);

/** Opens and activates a marimo notebook, then waits for the item to show. */
const showForMarimoNotebook = Effect.gen(function* () {
  const vscode = yield* VsCodeTest.Service;
  const visibility = yield* Visibility;
  const marimoEditor = VsCodeTest.makeNotebookEditor("/test/notebook_mo.py");
  yield* vscode.openNotebook(marimoEditor.notebook);
  yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));
  yield* visibility.await(true);
  Vitest.expect(yield* visibility.current).toBe(true);
});

it.effect(
  "should show status bar when marimo notebook is active",
  Effect.fn(function* () {
    yield* showForMarimoNotebook;
  }),
);

it.effect(
  "should hide status bar when Jupyter notebook becomes active",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const visibility = yield* Visibility;
    yield* showForMarimoNotebook;

    const jupyterEditor = VsCodeTest.makeNotebookEditor(
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
    const vscode = yield* VsCodeTest.Service;
    const visibility = yield* Visibility;
    yield* showForMarimoNotebook;

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
