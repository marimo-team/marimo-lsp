import * as Vitest from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as TestMarimoClient from "../../__tests__/__utils__/TestMarimoClient.ts";
import * as NotebookEditorRegistry from "../../notebook/NotebookEditorRegistry.ts";
import { MarimoNotebookCell } from "../../schemas/MarimoNotebookDocument.ts";
import * as ThemeSync from "../ThemeSync.ts";

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

const layerWith = (initialColorTheme: "light" | "dark") =>
  ThemeSync.layer.pipe(
    Layer.provide(NotebookEditorRegistry.layer),
    Layer.provideMerge(TestMarimoClient.layer),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(
      TestVsCode.layerWith({
        initialDocuments: [editor.notebook],
        initialColorTheme,
      }),
    ),
  );

const isTheme =
  (theme: "light" | "dark") => (command: TestMarimoClient.TestCommand) =>
    command.kind === "set-display-theme" && command.theme === theme;

Vitest.describe("ThemeSync", () => {
  Vitest.describe("light", () => {
    const it = EffectTest.make(layerWith("light"));

    it.effect(
      "sends set-display-theme on theme change",
      Effect.fn(function* () {
        const vscode = yield* TestVsCode.Service;
        const marimo = yield* TestMarimoClient.Service;
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* marimo.awaitCommands((commands) => commands.length >= 2);

        yield* vscode.setColorTheme("dark");
        yield* marimo.awaitCommands((commands) =>
          commands.some(isTheme("dark")),
        );

        Vitest.expect(yield* marimo.commands).toMatchInlineSnapshot(`
          [
            {
              "kind": "set-display-theme",
              "theme": "light",
            },
            {
              "kind": "set-display-theme",
              "theme": "light",
            },
            {
              "kind": "set-display-theme",
              "theme": "dark",
            },
          ]
        `);
      }),
    );

    it.effect(
      "sends set-display-theme while no marimo notebook is active",
      Effect.fn(function* () {
        const vscode = yield* TestVsCode.Service;
        const marimo = yield* TestMarimoClient.Service;
        yield* vscode.setActiveNotebookEditor(Option.none());
        yield* marimo.awaitCommands((commands) => commands.length >= 1);

        yield* vscode.setColorTheme("dark");
        yield* marimo.awaitCommands((commands) =>
          commands.some(isTheme("dark")),
        );

        Vitest.expect(yield* marimo.commands).toContainEqual({
          kind: "set-display-theme",
          theme: "dark",
        });
      }),
    );
  });

  Vitest.describe("dark", () => {
    const it = EffectTest.make(layerWith("dark"));

    it.effect(
      "syncs theme when a new notebook becomes active",
      Effect.fn(function* () {
        const vscode = yield* TestVsCode.Service;
        const marimo = yield* TestMarimoClient.Service;
        yield* vscode.setActiveNotebookEditor(Option.some(editor));
        yield* marimo.awaitCommands((commands) => commands.length >= 2);

        Vitest.expect(yield* marimo.commands).toMatchInlineSnapshot(`
          [
            {
              "kind": "set-display-theme",
              "theme": "dark",
            },
            {
              "kind": "set-display-theme",
              "theme": "dark",
            },
          ]
        `);
      }),
    );
  });
});
