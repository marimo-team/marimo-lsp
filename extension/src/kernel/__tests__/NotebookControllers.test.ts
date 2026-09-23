import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { assert, expect, it as vitestIt } from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import * as NotebookControllers from "../../kernel/NotebookControllers.ts";
import * as NotebookRuntime from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import * as Constants from "../../platform/Constants.ts";
import * as VsCode from "../../platform/VsCode.ts";
import { makeControllerSelectionChanges } from "../ControllerSelectionChanges.ts";

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

const layerWith = (
  initialEnvironments: Parameters<typeof TestPythonExtension.layerWith>[0] = [],
) => {
  const runtime = makeTestNotebookRuntime();
  const controllers = NotebookControllers.layer.pipe(Layer.provide(runtime));

  return Layer.merge(runtime, controllers).pipe(
    Layer.provide(Constants.defaultLayer),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(TestVsCode.layer),
    Layer.provideMerge(TestPythonExtension.layerWith(initialEnvironments)),
  );
};

const globalExecutable = "/usr/local/bin/python3.11";
const homeExecutable = "/home/user/.venv/bin/python";
const firstEnvironment = TestPythonExtension.makeVenv(homeExecutable);
const secondEnvironment = TestPythonExtension.makeGlobalEnv(globalExecutable);

const it = EffectTest.make(layerWith());
const knownEnvironmentsIt = EffectTest.make(
  layerWith([firstEnvironment, secondEnvironment]),
);
const globalEnvironmentIt = EffectTest.make(layerWith([secondEnvironment]));
const homeEnvironmentIt = EffectTest.make(layerWith([firstEnvironment]));

knownEnvironmentsIt.effect(
  "registers controllers for the known Python environments",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    yield* NotebookRuntime.Service;

    expect((yield* vscode.snapshot).controllers).toEqual([
      "marimo-/home/user/.venv/bin/python",
      "marimo-/usr/local/bin/python3.11",
      "marimo-sandbox",
    ]);
  }),
);

vitestIt("distinguishes uv cache descendants from shared path prefixes", () => {
  expect(
    NotebookControllers.isPathInside(
      "/home/user/.cache/uv/archive-v0/env/bin/python",
      "/home/user/.cache/uv",
    ),
  ).toBe(true);
  expect(
    NotebookControllers.isPathInside(
      "/home/user/.cache/uv-other/bin/python",
      "/home/user/.cache/uv",
    ),
  ).toBe(false);
});

globalEnvironmentIt.effect(
  "attaches VS Code controller selections to the notebook runtime",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const notebooks = yield* NotebookRuntime.Service;
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

    const initial = yield* notebooks.forNotebook(
      notebookId(editor.notebook.uri.toString()),
    );
    expect(Option.isNone(yield* initial.getController)).toBe(true);

    // No drain before selecting: the controller's selection listener is
    // acquired in the same fiber turn as its creation, so an event fired
    // this early buffers until trackControllerSelections consumes it. This
    // mirrors VS Code restoring a persisted selection right at creation.
    yield* vscode.selectNotebookController(
      `marimo-${globalExecutable}`,
      editor.notebook,
      true,
    );
    yield* Effect.yieldNow;

    const selectedNotebook = yield* notebooks.forNotebook(
      notebookId(editor.notebook.uri.toString()),
    );
    const selected = yield* selectedNotebook.getController;
    assert(Option.isSome(selected));
    expect(selected.value.id).toBe(`marimo-${globalExecutable}`);
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

homeEnvironmentIt.effect(
  "adds and removes controllers when Python environments change",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const python = yield* TestPythonExtension.Service;
    yield* NotebookRuntime.Service;

    // Drain once so the forked environmentChanges consumer subscribes to
    // the mock PubSub before we publish; the PubSub has no replay, so an
    // event published before the fork first runs would be silently lost.
    // Production wraps a vscode event listener registered at activation.
    yield* Effect.yieldNow;

    yield* python.addEnvironment(secondEnvironment);
    yield* Effect.yieldNow;
    expect((yield* vscode.snapshot).controllers).toEqual([
      "marimo-/home/user/.venv/bin/python",
      "marimo-/usr/local/bin/python3.11",
      "marimo-sandbox",
    ]);

    yield* python.removeEnvironment(firstEnvironment);
    yield* Effect.yieldNow;
    expect((yield* vscode.snapshot).controllers).toEqual([
      "marimo-/usr/local/bin/python3.11",
      "marimo-sandbox",
    ]);
  }),
);

homeEnvironmentIt.effect(
  "keeps a selected controller when its Python environment disappears",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const python = yield* TestPythonExtension.Service;
    yield* NotebookRuntime.Service;
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
    yield* vscode.openNotebook(editor.notebook);
    // Drain so the selection listener and the environmentChanges consumer
    // (both forked during layer construction) are attached before the mock
    // events below fire; see the comments in the two tests above.
    yield* Effect.yieldNow;
    yield* vscode.selectNotebookController(
      `marimo-${homeExecutable}`,
      editor.notebook,
      true,
    );
    yield* Effect.yieldNow;

    yield* python.removeEnvironment(firstEnvironment);
    yield* Effect.yieldNow;

    expect((yield* vscode.snapshot).controllers).toContain(
      `marimo-${homeExecutable}`,
    );
  }),
);

globalEnvironmentIt.effect(
  "sets all controllers to default without a script header or adjacent venv",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    yield* NotebookRuntime.Service;
    const code = yield* VsCode.Service;
    const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");

    yield* vscode.setActiveNotebookEditor(Option.some(editor));
    yield* Effect.yieldNow;

    const { affinityUpdates } = yield* vscode.snapshot;
    expect(affinityUpdates).toHaveLength(2);
    expect(affinityMap(affinityUpdates)).toEqual({
      "marimo-sandbox": code.NotebookControllerAffinity.Default,
      [`marimo-${globalExecutable}`]: code.NotebookControllerAffinity.Default,
    });
  }),
);

globalEnvironmentIt.effect(
  "resets sandbox affinity after the script header is removed",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    yield* NotebookRuntime.Service;
    const code = yield* VsCode.Service;
    const uri = "/test/notebook_mo.py";

    yield* vscode.setActiveNotebookEditor(
      Option.some(scriptNotebookEditor(uri)),
    );
    yield* Effect.yieldNow;
    yield* vscode.setActiveNotebookEditor(
      Option.some(TestVsCode.makeNotebookEditor(uri)),
    );
    yield* Effect.yieldNow;

    const { affinityUpdates } = yield* vscode.snapshot;
    expect(affinityUpdates).toHaveLength(4);
    expect(affinityMap(affinityUpdates.slice(0, 2))).toEqual({
      "marimo-sandbox": code.NotebookControllerAffinity.Preferred,
      [`marimo-${globalExecutable}`]: code.NotebookControllerAffinity.Default,
    });
    expect(affinityMap(affinityUpdates.slice(2))).toEqual({
      "marimo-sandbox": code.NotebookControllerAffinity.Default,
      [`marimo-${globalExecutable}`]: code.NotebookControllerAffinity.Default,
    });
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

    const vscode = yield* TestVsCode.Service;
    const python = yield* TestPythonExtension.Service;
    yield* NotebookRuntime.Service;
    const code = yield* VsCode.Service;
    const uri = NodePath.join(project.path, "notebook_mo.py");

    yield* Effect.yieldNow;
    yield* python.addEnvironment(TestPythonExtension.makeVenv(executable));
    yield* Effect.yieldNow;
    yield* vscode.setActiveNotebookEditor(
      Option.some(TestVsCode.makeNotebookEditor(uri)),
    );
    yield* Effect.yieldNow;
    NodeFs.unlinkSync(pyvenvConfig);
    yield* vscode.setActiveNotebookEditor(
      Option.some(TestVsCode.makeNotebookEditor(uri)),
    );
    yield* Effect.yieldNow;

    const { affinityUpdates } = yield* vscode.snapshot;
    expect(affinityUpdates).toHaveLength(4);
    expect(affinityMap(affinityUpdates.slice(0, 2))).toEqual({
      "marimo-sandbox": code.NotebookControllerAffinity.Default,
      [`marimo-${executable}`]: code.NotebookControllerAffinity.Preferred,
    });
    expect(affinityMap(affinityUpdates.slice(2))).toEqual({
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

    const vscode = yield* TestVsCode.Service;
    const python = yield* TestPythonExtension.Service;
    yield* NotebookRuntime.Service;
    const code = yield* VsCode.Service;
    const uri = NodePath.join(project.path, "notebook_mo.py");

    yield* Effect.yieldNow;
    yield* python.addEnvironment(TestPythonExtension.makeVenv(executable));
    yield* Effect.yieldNow;
    yield* vscode.setActiveNotebookEditor(
      Option.some(scriptNotebookEditor(uri)),
    );
    yield* Effect.yieldNow;
    yield* vscode.setActiveNotebookEditor(
      Option.some(TestVsCode.makeNotebookEditor(uri)),
    );
    yield* Effect.yieldNow;

    const { affinityUpdates } = yield* vscode.snapshot;
    expect(affinityUpdates).toHaveLength(4);
    expect(affinityMap(affinityUpdates.slice(0, 2))).toEqual({
      "marimo-sandbox": code.NotebookControllerAffinity.Preferred,
      [`marimo-${executable}`]: code.NotebookControllerAffinity.Default,
    });
    expect(affinityMap(affinityUpdates.slice(2))).toEqual({
      "marimo-sandbox": code.NotebookControllerAffinity.Default,
      [`marimo-${executable}`]: code.NotebookControllerAffinity.Preferred,
    });
  }),
);
