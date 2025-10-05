import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { makeActivate } from "../../src/layers/Main.ts";
import { ExtensionContext } from "../services/Storage.ts";
import { TestExtensionContextLive } from "./TestExtensionContext.ts";
import { TestLanguageClientLive } from "./TestLanguageClient.ts";
import { TestPythonExtensionLive } from "./TestPythonExtension.ts";
import { TestVsCodeLive } from "./TestVsCode.ts";

const activate = makeActivate(
  Layer.empty.pipe(
    Layer.provideMerge(TestPythonExtensionLive),
    Layer.provideMerge(TestLanguageClientLive),
    Layer.provideMerge(TestVsCodeLive),
  ),
);

describe("extension", () => {
  it.effect("activation returns disposable", () =>
    Effect.gen(function* () {
      const context = yield* ExtensionContext;
      const disposable = yield* Effect.promise(() => activate(context));
      expect(disposable).toMatchInlineSnapshot(`
      {
        "dispose": [Function],
      }
    `);
    }).pipe(Effect.provide(TestExtensionContextLive)),
  );
});
