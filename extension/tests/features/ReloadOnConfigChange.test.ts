import * as Vitest from "@effect/vitest";
import { Effect, Latch, Layer, Option } from "effect";
import type * as vscode from "vscode";

import { commandId } from "../../src/commands.ts";
import restartKernel from "../../src/commands/restartKernel.ts";
import * as ReloadOnConfigChange from "../../src/features/ReloadOnConfigChange.ts";
import * as NotebookRuntimeTest from "../fake/NotebookRuntime.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { notebookId } from "../lib/branded.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const layerWith = (runtime = NotebookRuntimeTest.layerWith()) =>
  Layer.merge(VsCodeTest.layer, runtime);

const it = EffectTest.make(layerWith());
const affectedEditor = VsCodeTest.makeNotebookEditor("/project/notebook.py");
const affectedId = notebookId(affectedEditor.notebook.uri.toString());
const affectedSession = {
  executable: "/python",
  workingDirectory: "/project",
};
const affectedIt = EffectTest.make(
  layerWith(
    NotebookRuntimeTest.layerWith({
      runtimeSession: affectedSession,
      runtimeSessions: [{ notebookId: affectedId, session: affectedSession }],
    }),
  ),
);

it.effect(
  "runs the restart command only when selected",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    yield* vscode.selectInformationMessage("Restart Kernel");
    yield* ReloadOnConfigChange.promptForFileRootChange;
    Vitest.expect((yield* vscode.snapshot).executions).toContainEqual({
      command: commandId(restartKernel.command),
      args: [],
    });

    yield* ReloadOnConfigChange.promptForFileRootChange;
    Vitest.expect((yield* vscode.snapshot).executions).toHaveLength(1);
  }),
);

it.effect(
  "reloads after telemetry changes only when selected",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const configurationChange: vscode.ConfigurationChangeEvent = {
      affectsConfiguration: (section) => section === "marimo.telemetry",
    };
    yield* ReloadOnConfigChange.watch;
    yield* vscode.selectInformationMessage("Reload Window");

    yield* vscode.configurationChange(configurationChange);
    yield* vscode.configurationChange(configurationChange);
    yield* vscode.awaitInformationMessages(2);

    const snapshot = yield* vscode.snapshot;
    Vitest.expect(snapshot.informationMessages).toEqual([
      "Changing telemetry requires reloading the window to take effect.",
      "Changing telemetry requires reloading the window to take effect.",
    ]);
    Vitest.expect(snapshot.executions).toEqual([
      {
        command: "workbench.action.reloadWindow",
        args: [],
      },
    ]);
  }),
);

it.effect(
  "prompts to reload after changing the language-server runtime",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    yield* ReloadOnConfigChange.watch;
    yield* vscode.selectInformationMessage("Reload Window");
    yield* vscode.configurationChange({
      affectsConfiguration: (section) =>
        ["marimo.lsp.server", "marimo.lsp.path"].includes(section),
    });
    yield* vscode.awaitExecutions((executions) =>
      executions.some(
        ({ command }) => command === "workbench.action.reloadWindow",
      ),
    );

    const snapshot = yield* vscode.snapshot;
    Vitest.expect(snapshot.informationMessages).toEqual([
      "Changing the language-server runtime requires reloading the window to take effect.",
    ]);
    Vitest.expect(snapshot.executions).toContainEqual({
      command: "workbench.action.reloadWindow",
      args: [],
    });
  }),
);

affectedIt.effect(
  "prompts when an affected inactive RuntimeSession becomes active",
  Effect.fn(function* () {
    const vscode = yield* VsCodeTest.Service;
    const resourceChecked = yield* Latch.make();
    const configurationChange: vscode.ConfigurationChangeEvent = {
      affectsConfiguration: (section, resource) => {
        const affected =
          section === "marimo.notebookFileRoot" &&
          (resource === undefined ||
            ("scheme" in resource &&
              resource.scheme === affectedEditor.notebook.uri.scheme &&
              resource.path === affectedEditor.notebook.uri.path));
        if (affected && resource !== undefined) resourceChecked.openUnsafe();
        return affected;
      },
    };
    yield* ReloadOnConfigChange.watch;

    yield* vscode.configurationChange(configurationChange);
    yield* resourceChecked.await;
    yield* vscode.setActiveNotebookEditor(Option.some(affectedEditor));
    yield* vscode.awaitInformationMessages(1);

    Vitest.expect((yield* vscode.snapshot).informationMessages).toEqual([
      "The notebook file root changed. Restart the marimo kernel to apply it.",
    ]);
  }),
);
