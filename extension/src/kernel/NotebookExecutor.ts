import { Cause, Deferred, Effect, Fiber, Queue, type Scope } from "effect";

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
  readonly worker: Fiber.Fiber<void>;
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
          const actor = {
            queue,
            worker: yield* Effect.forkDetach(runWorker(queue)),
          } satisfies Actor<R>;
          actors.set(notebookId, actor);
          return actor;
        });

      const coordinator = yield* Effect.forkDetach(
        Effect.forever(
          Queue.take(ingress).pipe(
            Effect.flatMap((work) =>
              Effect.gen(function* () {
                const actor = yield* actorFor(work.notebookId);
                if (!(yield* Queue.offer(actor.queue, work))) {
                  yield* work.reject;
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
            // the coordinator before closing actors so all of them are routed.
            yield* Queue.end(ingress);
            yield* Fiber.join(coordinator);

            const currentActors = [...actors.values()];
            yield* Effect.forEach(
              currentActors,
              (actor) => Queue.end(actor.queue),
              { discard: true },
            );
            yield* Effect.forEach(
              currentActors,
              (actor) =>
                Effect.gen(function* () {
                  const buffered = yield* Queue.clear(actor.queue);
                  yield* Effect.forEach(buffered, (work) => work.reject, {
                    discard: true,
                  });
                }),
              { discard: true },
            );
            // Signal every worker before waiting for any one worker's cleanup.
            // If a command is active, Deferred.into records the interruption.
            yield* Fiber.interruptAll(
              currentActors.map((actor) => actor.worker),
            );
            yield* Effect.forEach(
              currentActors,
              (actor) => Queue.shutdown(actor.queue),
              { discard: true },
            );
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

      return { submit, post };
    }),
  );
}
