import * as Vitest from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as PythonEnvironmentStatusBar from "../PythonEnvironmentStatusBar.ts";
import * as TestPythonEnvironmentStatusBar from "./TestPythonEnvironmentStatusBar.ts";

/**
 * Integration tests for PythonEnvironmentStatusBar.
 *
 * The status bar shows when a marimo notebook is the active notebook editor.
 * It respects the Python extension's `python.interpreter.infoVisibility` setting:
 * - "always" or "never": We never show (defer to user preference)
 * - "onPythonRelated" (default): We show when marimo notebook is active
 */

const it = EffectTest.make(
  Layer.empty.pipe(
    Layer.provideMerge(PythonEnvironmentStatusBar.layer),
    Layer.provideMerge(TestPythonEnvironmentStatusBar.layer),
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
    const statusBar = yield* TestPythonEnvironmentStatusBar.Service;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* statusBar.awaitVisibility(true);
    Vitest.expect(yield* statusBar.visible).toBe(true);
  }),
);

it.effect(
  "should hide status bar when Jupyter notebook becomes active",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const statusBar = yield* TestPythonEnvironmentStatusBar.Service;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* statusBar.awaitVisibility(true);
    Vitest.expect(yield* statusBar.visible).toBe(true);

    const jupyterEditor = TestVsCode.makeNotebookEditor(
      "/test/notebook.ipynb",
      { notebookType: "jupyter-notebook" },
    );
    yield* vscode.openNotebook(jupyterEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(jupyterEditor));

    yield* statusBar.awaitVisibility(false);
    Vitest.expect(yield* statusBar.visible).toBe(false);
  }),
);

it.effect(
  "should hide status bar when no notebook is active",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const statusBar = yield* TestPythonEnvironmentStatusBar.Service;
    const marimoEditor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(marimoEditor.notebook);
    yield* vscode.setActiveNotebookEditor(Option.some(marimoEditor));

    yield* statusBar.awaitVisibility(true);
    Vitest.expect(yield* statusBar.visible).toBe(true);

    yield* vscode.setActiveNotebookEditor(Option.none());

    yield* statusBar.awaitVisibility(false);
    Vitest.expect(yield* statusBar.visible).toBe(false);
  }),
);

it.effect(
  "should hide status bar initially when no marimo notebook is open",
  Effect.fn(function* () {
    const statusBar = yield* TestPythonEnvironmentStatusBar.Service;
    Vitest.expect(yield* statusBar.visible).toBe(false);
  }),
);
