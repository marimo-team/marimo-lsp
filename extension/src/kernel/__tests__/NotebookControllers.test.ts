import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Option, Stream } from "effect";
import type * as vscode from "vscode";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as NotebookControllers from "../../kernel/NotebookControllers.ts";
import { makeControllerSelectionChanges } from "../ControllerSelectionChanges.ts";
import * as TestNotebookControllers from "./TestNotebookControllers.ts";

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
  TestVsCode.makeNotebookEditor(uri, {
    data: {
      cells: [],
      metadata: { marimo: { header: "/// script" } },
    },
  });

const globalExecutable = "/usr/local/bin/python3.11";
const homeExecutable = "/home/user/.venv/bin/python";
const firstEnvironment = TestPythonExtension.makeVenv(homeExecutable);
const secondEnvironment = TestPythonExtension.makeGlobalEnv(globalExecutable);
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
      TestNotebookControllers.layerWith([firstEnvironment, secondEnvironment]),
    );

    it.effect(
      "registers controllers for the known Python environments",
      Effect.fn(function* () {
        const controllers = yield* TestNotebookControllers.Service;
        Vitest.expect(yield* controllers.registered).toEqual(
          controllerIds(homeExecutable, globalExecutable),
        );
      }),
    );
  });

  Vitest.describe("with a global Python environment", () => {
    const it = EffectTest.make(
      TestNotebookControllers.layerWith([secondEnvironment]),
    );

    it.effect(
      "attaches VS Code controller selections to the notebook runtime",
      Effect.fn(function* () {
        const controllers = yield* TestNotebookControllers.Service;
        const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

        Vitest.expect(
          Option.isNone(yield* controllers.controllerFor(editor)),
        ).toBe(true);

        const selected = yield* controllers.select(
          `marimo-${globalExecutable}`,
          editor,
        );
        Vitest.expect(selected.id).toBe(`marimo-${globalExecutable}`);
      }),
    );

    it.effect(
      "sets all controllers to default without a script header or adjacent venv",
      Effect.fn(function* () {
        const controllers = yield* TestNotebookControllers.Service;
        const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

        yield* controllers.activate(editor, 2);

        const updates = yield* controllers.affinityUpdates;
        Vitest.expect(updates).toHaveLength(2);
        Vitest.expect(affinityMap(updates)).toEqual({
          "marimo-sandbox": controllers.code.NotebookControllerAffinity.Default,
          [`marimo-${globalExecutable}`]:
            controllers.code.NotebookControllerAffinity.Default,
        });
      }),
    );

    it.effect(
      "resets sandbox affinity after the script header is removed",
      Effect.fn(function* () {
        const controllers = yield* TestNotebookControllers.Service;
        const uri = "/test/notebook_mo.py";

        yield* controllers.activate(scriptNotebookEditor(uri), 2);
        yield* controllers.activate(TestVsCode.makeNotebookEditor(uri), 4);

        const updates = yield* controllers.affinityUpdates;
        Vitest.expect(updates).toHaveLength(4);
        Vitest.expect(affinityMap(updates.slice(0, 2))).toEqual({
          "marimo-sandbox":
            controllers.code.NotebookControllerAffinity.Preferred,
          [`marimo-${globalExecutable}`]:
            controllers.code.NotebookControllerAffinity.Default,
        });
        Vitest.expect(affinityMap(updates.slice(2))).toEqual({
          "marimo-sandbox": controllers.code.NotebookControllerAffinity.Default,
          [`marimo-${globalExecutable}`]:
            controllers.code.NotebookControllerAffinity.Default,
        });
      }),
    );
  });

  Vitest.describe("with a home virtual environment", () => {
    const it = EffectTest.make(
      TestNotebookControllers.layerWith([firstEnvironment]),
    );

    it.effect(
      "adds and removes controllers when Python environments change",
      Effect.fn(function* () {
        const controllers = yield* TestNotebookControllers.Service;

        yield* controllers.addEnvironment(
          secondEnvironment,
          controllerIds(homeExecutable, globalExecutable),
        );
        Vitest.expect(yield* controllers.registered).toEqual(
          controllerIds(homeExecutable, globalExecutable),
        );

        yield* controllers.removeEnvironment(
          firstEnvironment,
          controllerIds(globalExecutable),
        );
        Vitest.expect(yield* controllers.registered).toEqual(
          controllerIds(globalExecutable),
        );
      }),
    );

    it.effect(
      "keeps a selected controller when its Python environment disappears",
      Effect.fn(function* () {
        const controllers = yield* TestNotebookControllers.Service;
        const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
        yield* controllers.openNotebook(editor.notebook);
        yield* controllers.select(`marimo-${homeExecutable}`, editor);

        yield* controllers.removeEnvironment(
          firstEnvironment,
          controllerIds(homeExecutable),
        );

        Vitest.expect(yield* controllers.registered).toContain(
          `marimo-${homeExecutable}`,
        );
      }),
    );
  });

  Vitest.describe("with no known Python environments", () => {
    const it = EffectTest.make(TestNotebookControllers.layer);

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

        const controllers = yield* TestNotebookControllers.Service;
        const uri = NodePath.join(project.path, "notebook_mo.py");

        yield* controllers.addEnvironment(
          TestPythonExtension.makeVenv(executable),
          controllerIds(executable),
        );
        yield* controllers.activate(TestVsCode.makeNotebookEditor(uri), 2);
        NodeFs.unlinkSync(pyvenvConfig);
        yield* controllers.activate(TestVsCode.makeNotebookEditor(uri), 4);

        const updates = yield* controllers.affinityUpdates;
        Vitest.expect(updates).toHaveLength(4);
        Vitest.expect(affinityMap(updates.slice(0, 2))).toEqual({
          "marimo-sandbox": controllers.code.NotebookControllerAffinity.Default,
          [`marimo-${executable}`]:
            controllers.code.NotebookControllerAffinity.Preferred,
        });
        Vitest.expect(affinityMap(updates.slice(2))).toEqual({
          "marimo-sandbox": controllers.code.NotebookControllerAffinity.Default,
          [`marimo-${executable}`]:
            controllers.code.NotebookControllerAffinity.Default,
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

        const controllers = yield* TestNotebookControllers.Service;
        const uri = NodePath.join(project.path, "notebook_mo.py");

        yield* controllers.addEnvironment(
          TestPythonExtension.makeVenv(executable),
          controllerIds(executable),
        );
        yield* controllers.activate(scriptNotebookEditor(uri), 2);
        yield* controllers.activate(TestVsCode.makeNotebookEditor(uri), 4);

        const updates = yield* controllers.affinityUpdates;
        Vitest.expect(updates).toHaveLength(4);
        Vitest.expect(affinityMap(updates.slice(0, 2))).toEqual({
          "marimo-sandbox":
            controllers.code.NotebookControllerAffinity.Preferred,
          [`marimo-${executable}`]:
            controllers.code.NotebookControllerAffinity.Default,
        });
        Vitest.expect(affinityMap(updates.slice(2))).toEqual({
          "marimo-sandbox": controllers.code.NotebookControllerAffinity.Default,
          [`marimo-${executable}`]:
            controllers.code.NotebookControllerAffinity.Preferred,
        });
      }),
    );
  });
});
