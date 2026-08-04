import { describe, assert, expect, it } from "@effect/vitest";
import { Effect, Layer, LogLevel } from "effect";

import * as pkg from "../../package.json";
import { getTestExtensionContext } from "../__mocks__/TestExtensionContext.ts";
import { TestMarimoClientLive } from "../__mocks__/TestMarimoClient.ts";
import { TestPythonExtension } from "../__mocks__/TestPythonExtension.ts";
import { TestRuffLanguageServerLive } from "../__mocks__/TestRuffLanguageServer.ts";
import { TestTelemetryLive } from "../__mocks__/TestTelemetry.ts";
import { TestTyLanguageServerLive } from "../__mocks__/TestTyLanguageServer.ts";
import { TestVsCode } from "../__mocks__/TestVsCode.ts";
import { commandId } from "../commands.ts";
import hideCellCode from "../commands/hideCellCode.ts";
import showCellCode from "../commands/showCellCode.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { makeActivate } from "../features/Main.ts";
import { SANDBOX_CONTROLLER_ID } from "../ids.ts";

const withTestCtx = Effect.fn(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(vscode.layer),
    Layer.provideMerge(TestMarimoClientLive),
    Layer.provideMerge(TestPythonExtension.Default),
    Layer.provideMerge(TestTyLanguageServerLive),
    Layer.provideMerge(TestRuffLanguageServerLive),
    Layer.provideMerge(TestTelemetryLive),
  );
  return {
    layer,
    vscode,
    activate: makeActivate(layer, LogLevel.Error),
  };
});

describe("extension.activate", () => {
  it.scoped(
    "should return a disposable",
    Effect.fn(function* () {
      const { activate } = yield* withTestCtx();

      const context = yield* getTestExtensionContext();
      const disposable = yield* Effect.promise(() => activate(context));

      expect(disposable).toMatchInlineSnapshot(`
        {
          "dispose": [Function],
          "experimental": {
            "kernels": {
              "getKernel": [Function],
            },
          },
        }
      `);
      // Full activation builds the entire layer graph; the default 5s
      // timeout flakes under parallel-worker load.
    }),
    20_000,
  );

  it.scoped(
    "should register contributions on activation",
    Effect.fn(function* () {
      const { vscode, activate } = yield* withTestCtx();

      // activate the extension
      const context = yield* getTestExtensionContext();
      yield* Effect.promise(() => activate(context));

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
        when: "notebookType == 'marimo-notebook' && !notebookCellInputIsCollapsed",
        group: "3_edit@1",
      },
      {
        command: commandId(showCellCode.command),
        when: "notebookType == 'marimo-notebook' && notebookCellInputIsCollapsed",
        group: "3_edit@1",
      },
    ]);
  });
});
