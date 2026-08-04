import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { commandId } from "../../commands.ts";
import { MarimoConfigurationService } from "../../config/MarimoConfigurationService.ts";
import { marimoConfigFixture } from "../../lib/__tests__/branded.ts";
import { OutputChannel } from "../../platform/OutputChannel.ts";
import { createSetupCellCommand } from "../createSetupCell.ts";
import { publishMarimoNotebookCommand } from "../publishMarimoNotebook.ts";
import { showNotebookMenuCommand } from "../showNotebookMenu.ts";

const configLayer = Layer.succeed(
  MarimoConfigurationService,
  MarimoConfigurationService.make({
    getConfig: () =>
      Effect.succeed(
        marimoConfigFixture({
          runtime: { on_cell_change: "lazy", auto_reload: "autorun" },
        }),
      ),
    updateConfig: () => Effect.die("not implemented"),
    clearNotebook: () => Effect.die("not implemented"),
    streamOf: () => Stream.empty,
  }),
);

const testLayer = (vscode: TestVsCode) =>
  Layer.mergeAll(
    vscode.layer,
    configLayer,
    OutputChannel.Default.pipe(Layer.provide(vscode.layer)),
  );

describe("showNotebookMenu", () => {
  it.effect("offers a focused four-item notebook menu", () =>
    Effect.gen(function* () {
      const labels = yield* Ref.make<ReadonlyArray<string>>([]);
      const vscode = yield* TestVsCode.make({
        window: {
          showQuickPickItems: (items) =>
            Ref.set(
              labels,
              items.map((item) => item.label),
            ).pipe(Effect.as(Option.none())),
        },
      });

      yield* showNotebookMenuCommand
        .handler()
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* labels).toEqual([
        "$(zap) Reactivity",
        "$(save-all) Automatic exports",
        "$(gear) Create setup cell",
        "$(cloud-upload) Publish notebook",
      ]);
      expect(yield* Ref.get(vscode.executions)).toEqual([]);
    }),
  );

  it.effect("routes direct actions through their registered commands", () =>
    Effect.gen(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      const context = {
        notebookEditor: { notebookUri: editor.notebook.uri },
      };
      const vscode = yield* TestVsCode.make({
        window: {
          showQuickPickItems: (items) =>
            Effect.succeed(
              Option.fromNullable(
                items.find((item) => item.label.includes("Publish notebook")),
              ),
            ),
        },
      });

      yield* showNotebookMenuCommand
        .handler(context)
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* Ref.get(vscode.executions)).toContainEqual({
        command: commandId(publishMarimoNotebookCommand),
        args: [context],
      });
    }),
  );

  it.effect("routes setup-cell creation with the notebook context", () =>
    Effect.gen(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      const context = {
        notebookEditor: { notebookUri: editor.notebook.uri },
      };
      const vscode = yield* TestVsCode.make({
        window: {
          showQuickPickItems: (items) =>
            Effect.succeed(
              Option.fromNullable(
                items.find((item) => item.label.includes("Create setup cell")),
              ),
            ),
        },
      });

      yield* showNotebookMenuCommand
        .handler(context)
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* Ref.get(vscode.executions)).toContainEqual({
        command: commandId(createSetupCellCommand),
        args: [context],
      });
    }),
  );

  it.effect("shows the current reactivity state", () =>
    Effect.gen(function* () {
      const descriptions = yield* Ref.make<ReadonlyArray<string>>([]);
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
        window: {
          showQuickPickItems: (items, options) => {
            if (options?.title === "marimo notebook") {
              return Effect.succeed(
                Option.fromNullable(
                  items.find((item) => item.label.includes("Reactivity")),
                ),
              );
            }
            return Ref.set(
              descriptions,
              items.flatMap((item) => item.description ?? []),
            ).pipe(Effect.as(Option.none()));
          },
        },
      });
      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      yield* showNotebookMenuCommand
        .handler()
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* descriptions).toEqual(["Lazy", "Auto-run"]);
    }),
  );
});
