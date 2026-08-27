import { Effect, Ref } from "effect";

interface ScopedResourceCounts {
  readonly acquired: number;
  readonly released: number;
  readonly active: number;
}

/** Tracks test resource ownership using Effect's public scoped-resource API. */
export const makeScopedResourceCounter = Effect.fn(function* () {
  const counts = yield* Ref.make<ScopedResourceCounts>({
    acquired: 0,
    released: 0,
    active: 0,
  });
  const resource = Effect.acquireRelease(
    Ref.update(counts, (current) => ({
      ...current,
      acquired: current.acquired + 1,
      active: current.active + 1,
    })),
    () =>
      Ref.update(counts, (current) => ({
        ...current,
        released: current.released + 1,
        active: current.active - 1,
      })),
  );

  return {
    counts: Ref.get(counts),
    track<A, E, R>(effect: Effect.Effect<A, E, R>) {
      return Effect.scoped(resource.pipe(Effect.andThen(effect)));
    },
  };
});
