import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as OutputChannel from "../OutputChannel.ts";

const layer = Layer.empty.pipe(
  Layer.provideMerge(OutputChannel.layer),
  Layer.provide(TestVsCode.layer),
);

Vitest.describe("OutputChannel", () => {
  const it = EffectTest.make(layer);

  it.effect(
    "should build",
    Effect.fn(function* () {
      const api = yield* OutputChannel.Service;
      Vitest.expect(api).toBeDefined();
    }),
  );
});
