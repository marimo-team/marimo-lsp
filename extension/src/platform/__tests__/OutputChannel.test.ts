import * as Vitest from "@effect/vitest";
import { Effect, Layer } from "effect";

import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import * as OutputChannel from "../OutputChannel.ts";

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
