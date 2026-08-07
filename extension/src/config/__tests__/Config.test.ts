import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Config } from "../../config/Config.ts";

const ConfigLive = Layer.empty.pipe(
  Layer.provideMerge(Config.Default),
  Layer.provide(TestVsCode.Default),
);

it.layer(ConfigLive)("Config", (it) => {
  it.effect(
    "should build",
    Effect.fn(function* () {
      const api = yield* Config;
      expect(api).toBeDefined();
    }),
  );
});

it.effect(
  "defaults to the WASM language server without the VS Code API",
  Effect.fn(function* () {
    const config = yield* Config.pipe(Effect.provide(Config.Default));

    expect(yield* config.lsp.wasm).toBe(true);
  }),
);
