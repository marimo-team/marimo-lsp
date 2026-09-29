import * as Vitest from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import * as ThemeSync from "../../src/features/ThemeSync.ts";
import * as NotebookEditorRegistry from "../../src/notebook/NotebookEditorRegistry.ts";
import { MarimoNotebookCell } from "../../src/schemas/MarimoNotebookDocument.ts";
import * as MarimoClientTest from "../fake/MarimoClient.ts";
import * as TelemetryTest from "../fake/Telemetry.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const editor = VsCodeTest.makeNotebookEditor("/test/notebook_mo.py", {
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
    Layer.provideMerge(MarimoClientTest.layer),
    Layer.provide(TelemetryTest.layer),
    Layer.provideMerge(
      VsCodeTest.layerWith({
        initialDocuments: [editor.notebook],
        initialColorTheme,
      }),
    ),
  );

const isTheme =
  (theme: "light" | "dark") => (command: MarimoClientTest.Command) =>
    command.kind === "set-display-theme" && command.theme === theme;

Vitest.describe("ThemeSync", () => {
  Vitest.describe("light", () => {
    const it = EffectTest.make(layerWith("light"));

    it.effect(
      "sends set-display-theme on theme change",
      Effect.fn(function* () {
        const vscode = yield* VsCodeTest.Service;
        const marimo = yield* MarimoClientTest.Service;
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
        const vscode = yield* VsCodeTest.Service;
        const marimo = yield* MarimoClientTest.Service;
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
        const vscode = yield* VsCodeTest.Service;
        const marimo = yield* MarimoClientTest.Service;
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
