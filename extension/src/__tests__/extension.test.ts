import { describe, expect, it } from "@effect/vitest";
import { Layer, LogLevel } from "effect";
import { getExtensionContext } from "../__mocks__/TestExtensionContext.ts";
import { TestLanguageClientLive } from "../__mocks__/TestLanguageClient.ts";
import { TestPythonExtensionLive } from "../__mocks__/TestPythonExtension.ts";
import { TestVsCodeLive } from "../__mocks__/TestVsCode.ts";
import { makeActivate } from "../layers/Main.ts";

const activate = makeActivate(
  Layer.empty.pipe(
    Layer.provideMerge(TestPythonExtensionLive),
    Layer.provideMerge(TestLanguageClientLive),
    Layer.provideMerge(TestVsCodeLive),
  ),
  LogLevel.Error,
);

describe("extension", () => {
  it("activation returns disposable", async () => {
    const context = await getExtensionContext();
    const disposable = await activate(context);
    expect(disposable).toMatchInlineSnapshot(`
      {
        "dispose": [Function],
      }
    `);
  });
});
