import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, LogLevel } from "effect";

import * as pkg from "../../package.json";
import { getTestExtensionContext } from "../__mocks__/TestExtensionContext.ts";
import { TestLanguageClientLive } from "../__mocks__/TestLanguageClient.ts";
import { TestPythonExtension } from "../__mocks__/TestPythonExtension.ts";
import { TestRuffLanguageServerLive } from "../__mocks__/TestRuffLanguageServer.ts";
import { TestSentryLive } from "../__mocks__/TestSentry.ts";
import { TestTelemetryLive } from "../__mocks__/TestTelemetry.ts";
import { TestTyLanguageServerLive } from "../__mocks__/TestTyLanguageServer.ts";
import { TestVsCode } from "../__mocks__/TestVsCode.ts";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { SANDBOX_CONTROLLER_ID } from "../ids.ts";
import { makeActivate } from "../layers/Main.ts";

const withTestCtx = Effect.fnUntraced(function* () {
  const vscode = yield* TestVsCode.make();
  const layer = Layer.empty.pipe(
    Layer.provideMerge(vscode.layer),
    Layer.provideMerge(TestLanguageClientLive),
    Layer.provideMerge(TestPythonExtension.Default),
    Layer.provideMerge(TestTyLanguageServerLive),
    Layer.provideMerge(TestRuffLanguageServerLive),
    Layer.provideMerge(TestTelemetryLive),
    Layer.provideMerge(TestSentryLive),
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
    Effect.fnUntraced(function* () {
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
    }),
  );

  it.scoped(
    "should register contributions on activation",
    Effect.fnUntraced(function* () {
      const { vscode, activate } = yield* withTestCtx();

      // activate the extension
      const context = yield* getTestExtensionContext();
      yield* Effect.promise(() => activate(context));

      const snapshot = yield* vscode.snapshot();

      expect(snapshot.controllers).toEqual([SANDBOX_CONTROLLER_ID]);
      expect(snapshot.serializers).toEqual([NOTEBOOK_TYPE]);
      // We don't need to snapshot all commands and views, since we
      // check them against package.json below.

      // Should exactly match package.json (excluding dynamic commands)
      // Dynamic commands are created at runtime and shouldn't be in package.json
      const staticCommands = snapshot.commands.filter(
        (cmd: string) => !cmd.startsWith("marimo.dynamic."),
      );
      expect(new Set(pkg.contributes.commands.map((c) => c.command))).toEqual(
        new Set(staticCommands),
      );
      expect(
        new Set(
          pkg.contributes.views["marimo-explorer"].map((view) => view.id),
        ),
      ).toEqual(new Set(snapshot.views));

      assert.strictEqual(pkg.contributes.notebooks.length, 1);
      assert.strictEqual(pkg.contributes.notebooks[0].type, NOTEBOOK_TYPE);
    }),
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
});
