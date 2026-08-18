import {
  Cause,
  Deferred,
  Effect,
  Fiber,
  FiberSet,
  Queue,
  type Scope,
} from "effect";

import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";

type Restore = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

interface Work<R> {
  readonly notebookId: NotebookId;
  readonly run: (restore: Restore) => Effect.Effect<void, never, R>;
  readonly reject: Effect.Effect<void>;
}

interface Actor<R> {
  readonly queue: Queue.Queue<Work<R>, Cause.Done>;
}

/** Runs admitted work in FIFO order, independently for each notebook. */
export interface NotebookExecutor<R> {
  readonly submit: <A, E>(
    notebookId: NotebookId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E>;
  readonly post: (
    notebookId: NotebookId,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void>;
  /**
   * Releases the notebook's worker after all previously admitted work has
   * run. Later submissions for the same notebook start a fresh worker.
   */
  readonly retire: (notebookId: NotebookId) => Effect.Effect<void>;
}

/** Makes a scoped executor that owns every successfully admitted effect. */
export function makeNotebookExecutor<R>(): Effect.Effect<
  NotebookExecutor<R>,
  never,
  R | Scope.Scope
> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const ingress = yield* Queue.unbounded<Work<R>, Cause.Done>();
      const actors = new Map<NotebookId, Actor<R>>();
      const fibers = yield* FiberSet.make<void, never>();

      const closeActor = (notebookId: NotebookId, actor: Actor<R>) =>
        Effect.gen(function* () {
          if (actors.get(notebookId) === actor) actors.delete(notebookId);
          yield* Queue.end(actor.queue);
          const buffered = yield* Queue.clear(actor.queue);
          yield* Effect.forEach(buffered, (work) => work.reject, {
            discard: true,
          });
          yield* Queue.shutdown(actor.queue);
        });

      const runWorker = (queue: Queue.Queue<Work<R>, Cause.Done>) =>
        Effect.forever(
          Effect.uninterruptibleMask((restore) =>
            restore(Queue.take(queue)).pipe(
              Effect.flatMap((work) =>
                work
                  .run(restore)
                  .pipe(
                    Effect.catchCause((cause) =>
                      Cause.hasInterruptsOnly(cause)
                        ? Effect.void
                        : Effect.logError(
                            "Notebook executor event failed",
                          ).pipe(Effect.annotateLogs({ cause })),
                    ),
                  ),
              ),
            ),
          ),
        ).pipe(Effect.catchTag("Done", () => Effect.void));

      const actorFor = (notebookId: NotebookId) =>
        Effect.gen(function* () {
          const current = actors.get(notebookId);
          if (current !== undefined) return current;

          const queue = yield* Queue.unbounded<Work<R>, Cause.Done>();
          const actor: Actor<R> = { queue };
          actors.set(notebookId, actor);
          yield* FiberSet.run(
            fibers,
            runWorker(queue).pipe(
              Effect.ensuring(closeActor(notebookId, actor)),
            ),
          );
          return actor;
        });

      const coordinator = yield* FiberSet.run(
        fibers,
        Effect.forever(
          Queue.take(ingress).pipe(
            Effect.flatMap((work) =>
              Effect.gen(function* () {
                const actor = yield* actorFor(work.notebookId);
                if (!(yield* Queue.offer(actor.queue, work))) {
                  // The actor retired between lookup and offer. Retirement
                  // removes the map entry before ending the queue, so one
                  // retry lands on a fresh actor.
                  const fresh = yield* actorFor(work.notebookId);
                  if (!(yield* Queue.offer(fresh.queue, work))) {
                    yield* work.reject;
                  }
                }
              }),
            ),
          ),
        ).pipe(Effect.catchTag("Done", () => Effect.void)),
      );

      yield* Effect.addFinalizer(() =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            // Ending preserves every message admitted before this point. Join
            // the coordinator before the FiberSet interrupts workers so every
            // admitted message reaches an actor queue.
            yield* Queue.end(ingress);
            yield* Fiber.join(coordinator);
            yield* Queue.shutdown(ingress);
          }),
        ),
      );

      const submit = <A, E>(
        notebookId: NotebookId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const reply = yield* Deferred.make<A, E>();
            const work: Work<R> = {
              notebookId,
              run: (restoreWork) =>
                Deferred.into(restoreWork(effect), reply).pipe(Effect.asVoid),
              reject: Deferred.interrupt(reply).pipe(Effect.asVoid),
            };

            if (!(yield* Queue.offer(ingress, work))) {
              yield* work.reject;
            }

            // A successful offer transfers ownership to the executor. Caller
            // interruption only stops waiting for the reply.
            return yield* restore(Deferred.await(reply));
          }),
        );

      const post: NotebookExecutor<R>["post"] = (notebookId, effect) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const admitted = yield* Queue.offer(ingress, {
              notebookId,
              run: (restore) => restore(effect),
              reject: Effect.void,
            });
            if (!admitted) return yield* Effect.interrupt;
            return undefined;
          }),
        );

      // Routed through ingress like any work so it runs after everything
      // admitted for the notebook before it. Draining the queue after end
      // lets the worker finish those items and exit on Done.
      const retire: NotebookExecutor<R>["retire"] = (notebookId) =>
        Effect.uninterruptible(
          Queue.offer(ingress, {
            notebookId,
            run: () =>
              Effect.suspend(() => {
                const actor = actors.get(notebookId);
                if (actor === undefined) return Effect.void;
                actors.delete(notebookId);
                return Queue.end(actor.queue).pipe(Effect.asVoid);
              }),
            reject: Effect.void,
          }).pipe(Effect.asVoid),
        );

      return { submit, post, retire };
    }),
  );
}
