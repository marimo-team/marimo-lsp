import * as Vitest from "@effect/vitest";
import type { Vitest as EffectVitest } from "@effect/vitest";
import { Effect, Layer, Logger, Scope } from "effect";

export interface Interface<R> {
  readonly effect: Test<R | Scope.Scope>;
  readonly live: Test<R | Scope.Scope>;
}

export interface Test<R> extends EffectVitest.Test<R> {
  readonly each: EffectVitest.Tester<R>["each"];
  readonly skipIf: EffectVitest.Tester<R>["skipIf"];
}

const bind = <R, E>(
  test: EffectVitest.Tester<Scope.Scope>,
  layer: Layer.Layer<R, E>,
): Test<R | Scope.Scope> => {
  const bindTest =
    (
      target: EffectVitest.Test<Scope.Scope>,
    ): EffectVitest.Test<R | Scope.Scope> =>
    (name, body, options) =>
      target(
        name,
        (context) =>
          Effect.suspend(() => body(context)).pipe(Effect.provide(layer)),
        options,
      );
  const bound = bindTest(test);
  const each: Test<R | Scope.Scope>["each"] =
    (cases) => (name, body, options) =>
      test.each(cases)(
        name,
        (...args) =>
          Effect.suspend(() => body(...args)).pipe(Effect.provide(layer)),
        options,
      );
  const skipIf: Test<R | Scope.Scope>["skipIf"] = (condition) =>
    bindTest(test.skipIf(condition));
  return Object.assign(bound, { each, skipIf });
};

const quietLogging = Logger.layer([Logger.tracerLogger]);

const configure = <R, E>(layer: Layer.Layer<R, E>) =>
  layer.pipe(Layer.provideMerge(quietLogging));

/**
 * Binds an Effect layer to a test runner.
 *
 * The layer is built inside each test's scope, so stateful test services are
 * isolated even when several tests use the same runner.
 */
export const make = <R, E>(layer: Layer.Layer<R, E>): Interface<R> => ({
  effect: bind(Vitest.it.effect, configure(layer)),
  live: bind(Vitest.it.live, configure(layer)),
});

/**
 * Shares an Effect layer across a test suite.
 *
 * Use this for expensive resources whose state may safely be shared by the
 * tests in the suite. The layer is built once and released after the suite.
 */
export const layer = <R, E>(testLayer: Layer.Layer<R, E>) =>
  Vitest.layer(configure(testLayer));
