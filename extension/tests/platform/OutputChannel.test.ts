import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";

import * as OutputChannel from "../../src/platform/OutputChannel.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const layer = Layer.empty.pipe(
  Layer.provideMerge(OutputChannel.layer),
  Layer.provide(VsCodeTest.layer),
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
