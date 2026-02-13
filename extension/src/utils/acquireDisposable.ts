import { Effect, Scope } from "effect";

type Awaitable<T> = PromiseLike<T> | T;
interface Disposable {
  dispose: () => Awaitable<void>;
}

export function acquireDisposable<T extends Disposable>(
  createDisposable: () => Awaitable<T>,
): Effect.Effect<T, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.promise(async () => createDisposable()),
    (disposable) => Effect.promise(async () => disposable.dispose()),
  );
}
