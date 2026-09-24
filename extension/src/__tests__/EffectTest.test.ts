import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer, Ref } from "effect";

import * as EffectTest from "./__utils__/EffectTest.ts";

interface CounterService {
  readonly getAndIncrement: Effect.Effect<number>;
}

class Counter extends Context.Service<Counter, CounterService>()(
  "@test/Counter",
) {}

const counterLayer = Layer.effect(
  Counter,
  Effect.gen(function* () {
    const value = yield* Ref.make(0);
    return Counter.of({
      getAndIncrement: Ref.getAndUpdate(value, (current) => current + 1),
    });
  }),
);

const it = EffectTest.make(counterLayer);

it.effect("provides the bound layer", () =>
  Effect.gen(function* () {
    const counter = yield* Counter;
    Vitest.expect(yield* counter.getAndIncrement).toBe(0);
    Vitest.expect(yield* counter.getAndIncrement).toBe(1);
  }),
);

it.effect("builds stateful layers separately for every test", () =>
  Effect.gen(function* () {
    const counter = yield* Counter;
    Vitest.expect(yield* counter.getAndIncrement).toBe(0);
  }),
);

it.effect.each([{ expected: 0 }, { expected: 0 }])(
  "builds a fresh layer for table row %#",
  ({ expected }) =>
    Effect.gen(function* () {
      const counter = yield* Counter;
      Vitest.expect(yield* counter.getAndIncrement).toBe(expected);
    }),
);
