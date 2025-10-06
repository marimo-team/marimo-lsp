import { expect, it } from "@effect/vitest";
import { Effect, Layer, LogLevel } from "effect";
import { getTestExtensionContext } from "../__mocks__/TestExtensionContext.ts";
import { TestLanguageClientLive } from "../__mocks__/TestLanguageClient.ts";
import { TestPythonExtension } from "../__mocks__/TestPythonExtension.ts";
import { TestVsCode } from "../__mocks__/TestVsCode.ts";
import { makeActivate } from "../layers/Main.ts";

describe("extension.activate", () => {
  it.scoped(
    "should return a disposable",
    Effect.fnUntraced(function* () {
      const vscode = yield* TestVsCode.make();

      const activate = makeActivate(
        Layer.empty.pipe(
          Layer.provideMerge(vscode.layer),
          Layer.provideMerge(TestLanguageClientLive),
          Layer.provideMerge(TestPythonExtension.Default),
        ),
        LogLevel.Error,
      );

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
      const vscode = yield* TestVsCode.make();

      const activate = makeActivate(
        Layer.empty.pipe(
          Layer.provideMerge(vscode.layer),
          Layer.provideMerge(TestLanguageClientLive),
          Layer.provideMerge(TestPythonExtension.Default),
        ),
        LogLevel.Error,
      );

      // activate the extension
      const context = yield* getTestExtensionContext();
      yield* Effect.promise(() => activate(context));

      expect(yield* vscode.snapshot()).toMatchInlineSnapshot(`
        {
          "commands": [
            "marimo.clearRecentNotebooks",
            "marimo.createGist",
            "marimo.newMarimoNotebook",
            "marimo.runStale",
            "marimo.showMarimoMenu",
          ],
          "controllers": [],
          "serializers": [
            "marimo-notebook",
          ],
        }
      `);
    }),
  );
});
