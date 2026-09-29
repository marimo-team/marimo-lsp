import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";
import type * as vscode from "vscode";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import {
  makeTestMarimoClient,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import * as NotebookEditorRegistry from "../../notebook/NotebookEditorRegistry.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as ThemeSync from "../ThemeSync.ts";

export interface Interface {
  readonly vscode: TestVsCode.Interface;
  readonly editor: vscode.NotebookEditor;
  readonly executions: Effect.Effect<ReadonlyArray<TestCommand>>;
  readonly setTheme: (theme: "light" | "dark") => Effect.Effect<void>;
  readonly awaitExecutions: (
    predicate: (executions: ReadonlyArray<TestCommand>) => boolean,
  ) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/ThemeSync",
) {}

export const layerWith = (initialTheme: "light" | "dark") =>
  Layer.unwrap(
    Effect.gen(function* () {
      const theme = yield* SubscriptionRef.make(initialTheme);
      const executions = yield* SubscriptionRef.make<
        ReadonlyArray<TestCommand>
      >([]);
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py", {
        data: {
          cells: [
            {
              kind: 1,
              value: "",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      });
      const vscodeLayer = TestVsCode.layerWith(
        {
          initialDocuments: [editor.notebook],
        },
        {
          window: {
            colorThemeChanges: SubscriptionRef.changes(theme),
          },
        },
      );
      const environment = Layer.empty.pipe(
        Layer.provideMerge(ThemeSync.layer),
        Layer.provide(NotebookEditorRegistry.layer),
        Layer.provide(
          makeTestMarimoClient({
            send: (request) =>
              SubscriptionRef.update(executions, (current) => [
                ...current,
                request,
              ]).pipe(Effect.as({ success: true })),
          }),
        ),
        Layer.provide(TestTelemetryLive),
        Layer.provideMerge(vscodeLayer),
      );
      const fixture = Layer.effect(
        Service,
        Effect.gen(function* () {
          const vscode = yield* TestVsCode.Service;
          return Service.of({
            vscode,
            editor,
            executions: SubscriptionRef.get(executions),
            setTheme: (value) => SubscriptionRef.set(theme, value),
            awaitExecutions: (predicate) =>
              SubscriptionRef.changes(executions).pipe(
                Stream.filter(predicate),
                Stream.runHead,
                Effect.asVoid,
              ),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixture);
    }),
  );
