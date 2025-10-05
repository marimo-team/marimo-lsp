import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { vi } from "vitest";
import { MainLive } from "../../src/layers/Main.ts";
import { ExtensionContext } from "../services/Storage.ts";
import { TestExtensionContextLive } from "./TestExtensionContext.ts";
import { TestLanguageClientLive } from "./TestLanguageClient.ts";
import { TestPythonExtensionLive } from "./TestPythonExtension.ts";
import { TestVsCodeLive } from "./TestVsCode.ts";

vi.mock("../../src/layers/MainVsCode.ts", () => ({
  MainLiveVsCode: MainLive.pipe(
    Layer.provide(TestPythonExtensionLive),
    Layer.provide(TestVsCodeLive),
    Layer.provide(TestLanguageClientLive),
  ),
}));

import { activate } from "../extension.ts";

describe("extension", () => {
  it("activation returns expected interface", () =>
    Effect.provide(
      Effect.gen(function* () {
        const context = yield* ExtensionContext;
        const result = yield* Effect.tryPromise(() => activate(context));
        expect(result).toMatchInlineSnapshot();
      }),
      TestExtensionContextLive,
    ));
});
