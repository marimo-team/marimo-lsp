import type * as py from "@vscode/python-extension";
import { Context, Effect, Fiber, Layer, Option, Stream } from "effect";
import type * as vscode from "vscode";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import * as Constants from "../../platform/Constants.ts";
import * as VsCode from "../../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import * as NotebookControllers from "../NotebookControllers.ts";
import * as NotebookRuntime from "../NotebookRuntime.ts";

export interface Interface {
  readonly code: VsCode.Interface;
  readonly registered: Effect.Effect<ReadonlyArray<string>>;
  readonly affinityUpdates: Effect.Effect<
    ReadonlyArray<TestVsCode.AffinityUpdate>
  >;
  readonly awaitRegistered: (
    expected: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly addEnvironment: (
    environment: py.ResolvedEnvironment,
    expected: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly removeEnvironment: (
    environment: py.ResolvedEnvironment,
    expected: ReadonlyArray<string>,
  ) => Effect.Effect<void>;
  readonly select: (
    controllerId: string,
    editor: vscode.NotebookEditor,
  ) => Effect.Effect<NotebookRuntime.NotebookController>;
  readonly controllerFor: (
    editor: vscode.NotebookEditor,
  ) => Effect.Effect<Option.Option<NotebookRuntime.NotebookController>>;
  readonly activate: (
    editor: vscode.NotebookEditor,
    expectedAffinityUpdates: number,
  ) => Effect.Effect<void>;
  readonly openNotebook: (
    document: vscode.NotebookDocument,
  ) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookControllers",
) {}

const ids = (controllers: ReadonlyArray<vscode.NotebookController>) =>
  controllers.map((controller) => controller.id).toSorted();

const sameIds = (
  actual: ReadonlyArray<string>,
  expected: ReadonlyArray<string>,
) =>
  actual.length === expected.length &&
  actual.every((value, index) => value === expected[index]);

export const layerWith = (
  initialEnvironments: Array<py.ResolvedEnvironment> = [],
) =>
  Layer.suspend(() => {
    const vscodeLayer = TestVsCode.layer;
    const pythonLayer = TestPythonExtension.layerWith(initialEnvironments);
    const runtime = makeTestNotebookRuntime();
    const controllers = NotebookControllers.layer.pipe(Layer.provide(runtime));
    const environment = Layer.merge(runtime, controllers).pipe(
      Layer.provide(Constants.defaultLayer),
      Layer.provide(TestTelemetryLive),
      Layer.provideMerge(vscodeLayer),
      Layer.provideMerge(pythonLayer),
    );
    const model = Layer.effect(
      Service,
      Effect.gen(function* () {
        const vscode = yield* TestVsCode.Service;
        const python = yield* TestPythonExtension.Service;
        const notebooks = yield* NotebookRuntime.Service;
        const code = yield* VsCode.Service;

        const registered = vscode.controllers.pipe(Effect.map(ids));
        const awaitRegistered = (expected: ReadonlyArray<string>) => {
          const sorted = [...expected].toSorted();
          return vscode.controllerChanges.pipe(
            Stream.map(ids),
            Stream.filter((actual) => sameIds(actual, sorted)),
            Stream.runHead,
            Effect.asVoid,
          );
        };

        const addEnvironment: Interface["addEnvironment"] = (value, expected) =>
          python
            .addEnvironment(value)
            .pipe(Effect.andThen(awaitRegistered(expected)));
        const removeEnvironment: Interface["removeEnvironment"] = (
          value,
          expected,
        ) =>
          python
            .removeEnvironment(value)
            .pipe(Effect.andThen(awaitRegistered(expected)));

        const select: Interface["select"] = (controllerId, editor) =>
          Effect.gen(function* () {
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
            yield* vscode.selectNotebookController(
              controllerId,
              editor.notebook,
              true,
            );
            return Option.getOrThrow(yield* Fiber.join(selected)).controller;
          });

        const activate: Interface["activate"] = (
          editor,
          expectedAffinityUpdates,
        ) =>
          vscode.setActiveNotebookEditor(Option.some(editor)).pipe(
            Effect.andThen(
              vscode.affinityChanges.pipe(
                Stream.filter(
                  (updates) => updates.length >= expectedAffinityUpdates,
                ),
                Stream.runHead,
                Effect.asVoid,
              ),
            ),
          );

        const controllerFor: Interface["controllerFor"] = (editor) =>
          notebooks
            .forNotebook(MarimoNotebookDocument.from(editor.notebook).id)
            .pipe(Effect.flatMap((notebook) => notebook.getController));

        return Service.of({
          code,
          registered,
          affinityUpdates: Effect.map(
            vscode.snapshot,
            (state) => state.affinityUpdates,
          ),
          awaitRegistered,
          addEnvironment,
          removeEnvironment,
          select,
          controllerFor,
          activate,
          openNotebook: vscode.openNotebook,
        });
      }),
    ).pipe(Layer.provide(environment));

    return Layer.merge(environment, model);
  });

export const layer = layerWith();
