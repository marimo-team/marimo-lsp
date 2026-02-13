import { Effect } from "effect";

export const acquireDisposable = <
  T extends { dispose: () => Thenable<void> | void },
>(
  fn: () => Thenable<T> | T,
) =>
  Effect.acquireRelease(
    Effect.promise(async () => fn()),
    (disposable) => Effect.promise(async () => disposable.dispose()),
  );
