import { it as vitestIt, type Vitest } from "@effect/vitest";
import { Effect, Layer, Scope } from "effect";

export interface Interface<R> {
  readonly effect: Test<R | Scope.Scope>;
  readonly live: Test<R | Scope.Scope>;
}

export interface Test<R> extends Vitest.Test<R> {
  readonly each: Vitest.Tester<R>["each"];
}

const bind = <R, E>(
  test: Vitest.Tester<Scope.Scope>,
  layer: Layer.Layer<R, E>,
): Test<R | Scope.Scope> => {
  const bound: Vitest.Test<R | Scope.Scope> = (name, body, options) =>
    test(
      name,
      (context) =>
        Effect.suspend(() => body(context)).pipe(Effect.provide(layer)),
      options,
    );
  const each: Test<R | Scope.Scope>["each"] =
    (cases) => (name, body, options) =>
      test.each(cases)(
        name,
        (...args) =>
          Effect.suspend(() => body(...args)).pipe(Effect.provide(layer)),
        options,
      );
  return Object.assign(bound, { each });
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
