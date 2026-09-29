import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import type * as py from "@vscode/python-extension";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import { makeControllerSelectionChanges } from "../../src/kernel/ControllerSelectionChanges.ts";
import * as NotebookControllers from "../../src/kernel/NotebookControllers.ts";
import * as NotebookRuntime from "../../src/kernel/NotebookRuntime.ts";
import * as Constants from "../../src/platform/Constants.ts";
import * as VsCode from "../../src/platform/VsCode.ts";
import { MarimoNotebookDocument } from "../../src/schemas/MarimoNotebookDocument.ts";
import * as NotebookRuntimeTest from "../fake/NotebookRuntime.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as VsCodeValues from "../fake/VsCodeValues.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const layerWith = (initialEnvironments: Array<py.ResolvedEnvironment> = []) =>
  Layer.suspend(() => {
    const runtime = NotebookRuntimeTest.layerWith();
    return NotebookControllers.layer.pipe(
      Layer.provideMerge(runtime),
      Layer.provide(Constants.defaultLayer),
      Layer.provide(TelemetryTest.layer),
      Layer.provideMerge(VsCodeTest.layer),
      Layer.provideMerge(PythonExtensionTest.layerWith(initialEnvironments)),
    );
  });

const ids = (controllers: ReadonlyArray<vscode.NotebookController>) =>
  controllers.map((controller) => controller.id).toSorted();

const sameIds = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

/** Sorted IDs of the controllers registered with VS Code. */
const registered = Effect.gen(function* () {
  const vscode = yield* VsCodeTest.Service;
  return ids(yield* vscode.controllers);
});

const awaitRegistered = Effect.fn("awaitRegistered")(function* (
  expected: ReadonlyArray<string>,
) {
  const vscode = yield* VsCodeTest.Service;
  const sorted = [...expected].toSorted();
  yield* vscode.controllerChanges.pipe(
    Stream.map(ids),
    Stream.filter((actual) => sameIds(actual, sorted)),
    Stream.runHead,
  );
});

const addEnvironment = Effect.fn("addEnvironment")(function* (
  environment: py.ResolvedEnvironment,
  expected: ReadonlyArray<string>,
) {
  const python = yield* PythonExtensionTest.Service;
  yield* python.addEnvironment(environment);
  yield* awaitRegistered(expected);
});

const removeEnvironment = Effect.fn("removeEnvironment")(function* (
  environment: py.ResolvedEnvironment,
  expected: ReadonlyArray<string>,
) {
  const python = yield* PythonExtensionTest.Service;
  yield* python.removeEnvironment(environment);
  yield* awaitRegistered(expected);
});

/** Selects a controller in VS Code and returns the runtime's attached one. */
const select = Effect.fn("select")(function* (
  controllerId: string,
  editor: vscode.NotebookEditor,
) {
  const vscode = yield* VsCodeTest.Service;
  const notebooks = yield* NotebookRuntime.Service;
  const notebookId = MarimoNotebookDocument.from(editor.notebook).id;
  const selected = yield* notebooks.controllerChanges.pipe(
    Stream.filter(
      (change) =>
        change.notebookUri === notebookId &&
        change.controller.id === controllerId,
    ),
    Stream.runHead,
    Effect.forkChild({ startImmediately: true }),
  );
  yield* vscode.selectNotebookController(controllerId, editor.notebook, true);
  return Option.getOrThrow(yield* Fiber.join(selected)).controller;
});

const controllerFor = Effect.fn("controllerFor")(function* (
  editor: vscode.NotebookEditor,
) {
  const notebooks = yield* NotebookRuntime.Service;
  const notebook = yield* notebooks.forNotebook(
    MarimoNotebookDocument.from(editor.notebook).id,
  );
  return yield* notebook.getController;
});

/** Activates the editor and waits for the expected number of affinity updates. */
const activate = Effect.fn("activate")(function* (
  editor: vscode.NotebookEditor,
  expectedAffinityUpdates: number,
) {
  const vscode = yield* VsCodeTest.Service;
  yield* vscode.setActiveNotebookEditor(Option.some(editor));
  yield* vscode.affinityChanges.pipe(
    Stream.filter((updates) => updates.length >= expectedAffinityUpdates),
    Stream.runHead,
  );
});

const affinityUpdates = Effect.gen(function* () {
  const vscode = yield* VsCodeTest.Service;
  return (yield* vscode.snapshot).affinityUpdates;
});

const affinityMap = (
  updates: ReadonlyArray<{
    controllerId: string;
    affinity: vscode.NotebookControllerAffinity;
  }>,
) =>
  Object.fromEntries(
    updates.map(({ controllerId, affinity }) => [controllerId, affinity]),
  );

const scriptNotebookEditor = (uri: string) =>
  VsCodeValues.makeNotebookEditor(uri, {
    data: {
      cells: [],
      metadata: { marimo: { header: "/// script" } },
    },
  });

const globalExecutable = "/usr/local/bin/python3.11";
const homeExecutable = "/home/user/.venv/bin/python";
const firstEnvironment = PythonExtensionTest.makeVenv(homeExecutable);
const secondEnvironment = PythonExtensionTest.makeGlobalEnv(globalExecutable);
const controllerIds = (...executables: ReadonlyArray<string>) =>
  [
    ...executables.map((executable) => `marimo-${executable}`),
    "marimo-sandbox",
  ].toSorted();

Vitest.describe("NotebookControllers", () => {
  Vitest.it(
    "distinguishes uv cache descendants from shared path prefixes",
    () => {
      Vitest.expect(
        NotebookControllers.isPathInside(
          "/home/user/.cache/uv/archive-v0/env/bin/python",
          "/home/user/.cache/uv",
        ),
      ).toBe(true);
      Vitest.expect(
        NotebookControllers.isPathInside(
          "/home/user/.cache/uv-other/bin/python",
          "/home/user/.cache/uv",
        ),
      ).toBe(false);
    },
  );

  Vitest.describe("with known Python environments", () => {
    const it = EffectTest.make(
      layerWith([firstEnvironment, secondEnvironment]),
    );

    it.effect(
      "registers controllers for the known Python environments",
      Effect.fn(function* () {
        Vitest.expect(yield* registered).toEqual(
          controllerIds(homeExecutable, globalExecutable),
        );
      }),
    );
  });

  Vitest.describe("with a global Python environment", () => {
    const it = EffectTest.make(layerWith([secondEnvironment]));

    it.effect(
      "attaches VS Code controller selections to the notebook runtime",
      Effect.fn(function* () {
        const editor = VsCodeValues.makeNotebookEditor("/test/notebook_mo.py");

        Vitest.expect(Option.isNone(yield* controllerFor(editor))).toBe(true);

        const selected = yield* select(`marimo-${globalExecutable}`, editor);
        Vitest.expect(selected.id).toBe(`marimo-${globalExecutable}`);
      }),
    );

    it.effect(
      "sets all controllers to default without a script header or adjacent venv",
      Effect.fn(function* () {
        const code = yield* VsCode.Service;
        const editor = VsCodeValues.makeNotebookEditor("/test/notebook_mo.py");

        yield* activate(editor, 2);

        const updates = yield* affinityUpdates;
        Vitest.expect(updates).toHaveLength(2);
        Vitest.expect(affinityMap(updates)).toEqual({
          "marimo-sandbox": code.NotebookControllerAffinity.Default,
          [`marimo-${globalExecutable}`]:
            code.NotebookControllerAffinity.Default,
        });
      }),
    );

    it.effect(
      "resets sandbox affinity after the script header is removed",
      Effect.fn(function* () {
        const code = yield* VsCode.Service;
        const uri = "/test/notebook_mo.py";

        yield* activate(scriptNotebookEditor(uri), 2);
        yield* activate(VsCodeValues.makeNotebookEditor(uri), 4);

        const updates = yield* affinityUpdates;
        Vitest.expect(updates).toHaveLength(4);
        Vitest.expect(affinityMap(updates.slice(0, 2))).toEqual({
          "marimo-sandbox": code.NotebookControllerAffinity.Preferred,
          [`marimo-${globalExecutable}`]:
            code.NotebookControllerAffinity.Default,
        });
        Vitest.expect(affinityMap(updates.slice(2))).toEqual({
          "marimo-sandbox": code.NotebookControllerAffinity.Default,
          [`marimo-${globalExecutable}`]:
            code.NotebookControllerAffinity.Default,
        });
      }),
    );
  });

  Vitest.describe("with a home virtual environment", () => {
    const it = EffectTest.make(layerWith([firstEnvironment]));

    it.effect(
      "adds and removes controllers when Python environments change",
      Effect.fn(function* () {
        yield* addEnvironment(
          secondEnvironment,
          controllerIds(homeExecutable, globalExecutable),
        );
        Vitest.expect(yield* registered).toEqual(
          controllerIds(homeExecutable, globalExecutable),
        );

        yield* removeEnvironment(
          firstEnvironment,
          controllerIds(globalExecutable),
        );
        Vitest.expect(yield* registered).toEqual(
          controllerIds(globalExecutable),
        );
      }),
    );

    it.effect(
      "keeps a selected controller when its Python environment disappears",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const editor = VsCodeValues.makeNotebookEditor("/test/notebook_mo.py");
        yield* vscode.openNotebook(editor.notebook);
        yield* select(`marimo-${homeExecutable}`, editor);

        yield* removeEnvironment(
          firstEnvironment,
          controllerIds(homeExecutable),
        );

        Vitest.expect(yield* registered).toContain(`marimo-${homeExecutable}`);
      }),
    );
  });

  Vitest.describe("with no known Python environments", () => {
    const it = EffectTest.make(layerWith());

    it.effect(
      "disposes the controller selection listener when its consumer ends",
      Effect.fn(function* () {
        const editor = VsCodeValues.makeNotebookEditor("/test/notebook_mo.py");
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
          Effect.forkChild({ startImmediately: true }),
        );
        emit?.({ notebook: editor.notebook, selected: true });
        yield* Fiber.join(consumer);

        Vitest.expect(disposals).toBe(1);
        Vitest.expect(emit).toBeUndefined();
      }),
    );

    it.live(
      "resets venv affinity after the adjacent venv is removed",
      Effect.fn(function* () {
        using project = NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-controller-affinity-"),
        );
        const venv = NodePath.join(project.path, ".venv");
        const executable = NodePath.join(venv, "bin", "python");
        const pyvenvConfig = NodePath.join(venv, "pyvenv.cfg");
        NodeFs.mkdirSync(NodePath.dirname(executable), { recursive: true });
        NodeFs.writeFileSync(pyvenvConfig, "");

        const code = yield* VsCode.Service;
        const uri = NodePath.join(project.path, "notebook_mo.py");

        yield* addEnvironment(
          PythonExtensionTest.makeVenv(executable),
          controllerIds(executable),
        );
        yield* activate(VsCodeValues.makeNotebookEditor(uri), 2);
        NodeFs.unlinkSync(pyvenvConfig);
        yield* activate(VsCodeValues.makeNotebookEditor(uri), 4);

        const updates = yield* affinityUpdates;
        Vitest.expect(updates).toHaveLength(4);
        Vitest.expect(affinityMap(updates.slice(0, 2))).toEqual({
          "marimo-sandbox": code.NotebookControllerAffinity.Default,
          [`marimo-${executable}`]: code.NotebookControllerAffinity.Preferred,
        });
        Vitest.expect(affinityMap(updates.slice(2))).toEqual({
          "marimo-sandbox": code.NotebookControllerAffinity.Default,
          [`marimo-${executable}`]: code.NotebookControllerAffinity.Default,
        });
      }),
    );

    it.live(
      "demotes sandbox affinity when an adjacent venv replaces the script header",
      Effect.fn(function* () {
        using project = NodeFs.mkdtempDisposableSync(
          NodePath.join(NodeOs.tmpdir(), "marimo-controller-affinity-"),
        );
        const venv = NodePath.join(project.path, ".venv");
        const executable = NodePath.join(venv, "bin", "python");
        NodeFs.mkdirSync(NodePath.dirname(executable), { recursive: true });
        NodeFs.writeFileSync(NodePath.join(venv, "pyvenv.cfg"), "");

        const code = yield* VsCode.Service;
        const uri = NodePath.join(project.path, "notebook_mo.py");

        yield* addEnvironment(
          PythonExtensionTest.makeVenv(executable),
          controllerIds(executable),
        );
        yield* activate(scriptNotebookEditor(uri), 2);
        yield* activate(VsCodeValues.makeNotebookEditor(uri), 4);

        const updates = yield* affinityUpdates;
        Vitest.expect(updates).toHaveLength(4);
        Vitest.expect(affinityMap(updates.slice(0, 2))).toEqual({
          "marimo-sandbox": code.NotebookControllerAffinity.Preferred,
          [`marimo-${executable}`]: code.NotebookControllerAffinity.Default,
        });
        Vitest.expect(affinityMap(updates.slice(2))).toEqual({
          "marimo-sandbox": code.NotebookControllerAffinity.Default,
          [`marimo-${executable}`]: code.NotebookControllerAffinity.Preferred,
        });
      }),
    );
  });
});
