import { describe, assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Ref } from "effect";

import * as pkg from "../../package.json";
import { getTestExtensionContext } from "../__mocks__/TestExtensionContext.ts";
import { TestPythonExtension } from "../__mocks__/TestPythonExtension.ts";
import { TestRuffLanguageServerLive } from "../__mocks__/TestRuffLanguageServer.ts";
import { TestTelemetryLive } from "../__mocks__/TestTelemetry.ts";
import { TestTyLanguageServerLive } from "../__mocks__/TestTyLanguageServer.ts";
import { TestVsCode } from "../__mocks__/TestVsCode.ts";
import { commandId } from "../commands.ts";
import disableCell from "../commands/disableCell.ts";
import hideCellCode from "../commands/hideCellCode.ts";
import showCellCode from "../commands/showCellCode.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { makeExtension } from "../features/Main.ts";
import { SANDBOX_CONTROLLER_ID } from "../ids.ts";
import { makeTestMarimoClient } from "./__utils__/TestMarimoClient.ts";

const withTestCtx = Effect.fn(function* (
  additionalLayer: Layer.Layer<never> = Layer.empty,
) {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.merge(additionalLayer),
    Layer.provideMerge(vscode.layer),
    Layer.provideMerge(makeTestMarimoClient()),
    Layer.provideMerge(TestPythonExtension.layer),
    Layer.provideMerge(TestTyLanguageServerLive),
    Layer.provideMerge(TestRuffLanguageServerLive),
    Layer.provideMerge(TestTelemetryLive),
  );
  return {
    vscode,
    extension: makeExtension(layer, "Error"),
  };
});

describe("extension.activate", () => {
  it.effect(
    "should return the public API",
    Effect.fn(function* () {
      const { extension } = yield* withTestCtx();

      const context = yield* getTestExtensionContext;
      const api = yield* Effect.promise(() => extension.activate(context));

      expect(api).toMatchInlineSnapshot(`
        {
          "experimental": {
            "kernels": {
              "getKernel": [Function],
            },
          },
        }
      `);
      yield* Effect.promise(() => extension.deactivate());
      // Full activation builds the entire layer graph; the default 5s
      // timeout flakes under parallel-worker load.
    }),
    20_000,
  );

  it.effect(
    "should own contributions until deactivation",
    Effect.fn(function* () {
      const { vscode, extension } = yield* withTestCtx();

      // activate the extension
      const context = yield* getTestExtensionContext;
      yield* Effect.promise(() => extension.activate(context));

      const snapshot = yield* vscode.snapshot();

      expect(snapshot.controllers).toEqual([SANDBOX_CONTROLLER_ID]);
      expect(snapshot.serializers).toEqual([NOTEBOOK_TYPE]);
      // We don't need to snapshot all commands and views, since we
      // check them against package.json below.

      expect(new Set(pkg.contributes.commands.map((c) => c.command))).toEqual(
        new Set(snapshot.commands),
      );
      expect(
        new Set(
          pkg.contributes.views["marimo-explorer"].map((view) => view.id),
        ),
      ).toEqual(new Set(snapshot.views));

      assert.strictEqual(pkg.contributes.notebooks.length, 1);
      assert.strictEqual(pkg.contributes.notebooks[0].type, NOTEBOOK_TYPE);

      yield* Effect.promise(() => extension.deactivate());
      expect(yield* vscode.snapshot()).toEqual({
        views: [],
        commands: [],
        serializers: [],
        controllers: [],
      });
    }),
    20_000,
  );

  it.effect(
    "should dispose the runtime exactly once",
    Effect.fn(function* () {
      const disposals = yield* Ref.make(0);
      const finalizer = Layer.effectDiscard(
        Effect.addFinalizer(() => Ref.update(disposals, (count) => count + 1)),
      );
      const { extension } = yield* withTestCtx(finalizer);

      const context = yield* getTestExtensionContext;
      yield* Effect.promise(() => extension.activate(context));
      yield* Effect.promise(() => extension.deactivate());
      yield* Effect.promise(() => extension.deactivate());

      expect(yield* Ref.get(disposals)).toBe(1);
    }),
    20_000,
  );
});

describe("package.json validation", () => {
  it("all commands in commandPalette menu should exist in main commands list", () => {
    const commandIds = new Set(pkg.contributes.commands.map((c) => c.command));
    const commandPaletteIds =
      pkg.contributes.menus.commandPalette?.map((item) => item.command) || [];

    for (const commandId of commandPaletteIds) {
      expect(
        commandIds.has(commandId),
        `Command "${commandId}" in menus.commandPalette does not exist in contributes.commands`,
      ).toBe(true);
    }
  });

  it("shows the cell visibility action matching the target cell state", () => {
    expect(pkg.contributes.menus["notebook/cell/title"]).toEqual([
      {
        command: commandId(hideCellCode.command),
        when: "notebookType == 'marimo-notebook' && notebookCellType == 'code' && !notebookCellInputIsCollapsed",
        group: "3_edit@1",
      },
      {
        command: commandId(showCellCode.command),
        when: "notebookType == 'marimo-notebook' && notebookCellType == 'code' && notebookCellInputIsCollapsed",
        group: "3_edit@1",
      },
      {
        command: commandId(disableCell.command),
        when: "notebookType == 'marimo-notebook' && notebookCellType == 'code'",
        group: "3_edit@2",
      },
    ]);
  });
});
