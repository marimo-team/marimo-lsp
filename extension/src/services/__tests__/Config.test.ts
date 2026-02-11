import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Config } from "../Config.ts";

const ConfigLive = Layer.empty.pipe(
  Layer.provideMerge(Config.Default),
  Layer.provide(TestVsCode.Default),
);

it.layer(ConfigLive)("Config", (it) => {
  it.effect(
    "should build",
    Effect.fnUntraced(function* () {
      const api = yield* Config;
      expect(api).toBeDefined();
    }),
  );
});
