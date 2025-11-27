import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, LogLevel } from "effect";
import * as pkg from "../../package.json";
import { getTestExtensionContext } from "../__mocks__/TestExtensionContext.ts";
import { TestLanguageClientLive } from "../__mocks__/TestLanguageClient.ts";
import { TestPythonExtension } from "../__mocks__/TestPythonExtension.ts";
import { TestPythonLanguageServerLive } from "../__mocks__/TestPythonLanguageServer.ts";
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
    Layer.provideMerge(TestPythonLanguageServerLive),
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
