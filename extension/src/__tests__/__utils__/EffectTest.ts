import { it as vitestIt, type Vitest } from "@effect/vitest";
import { Effect, Layer, Scope } from "effect";

export interface Interface<R> {
  readonly effect: Test<R | Scope.Scope>;
  readonly live: Test<R | Scope.Scope>;
}

export interface Test<R> extends Vitest.Test<R> {
  readonly each: Vitest.Tester<R>["each"];
  readonly skipIf: Vitest.Tester<R>["skipIf"];
}

const bind = <R, E>(
  test: Vitest.Tester<Scope.Scope>,
  layer: Layer.Layer<R, E>,
): Test<R | Scope.Scope> => {
  const bindTest =
    (target: Vitest.Test<Scope.Scope>): Vitest.Test<R | Scope.Scope> =>
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

/**
 * Binds an Effect layer to a test runner.
 *
 * The layer is built inside each test's scope, so stateful test services are
 * isolated even when several tests use the same runner.
 */
export const make = <R, E>(layer: Layer.Layer<R, E>): Interface<R> => ({
  effect: bind(vitestIt.effect, layer),
  live: bind(vitestIt.live, layer),
});
