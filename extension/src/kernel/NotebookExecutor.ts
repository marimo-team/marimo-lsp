import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Predicate,
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
  readonly worker: Fiber.Fiber<void>;
}

/** The scope that owned an admitted notebook command closed before it ended. */
export class NotebookExecutionScopeClosedError extends Data.TaggedError(
  "NotebookExecutionScopeClosedError",
)<{ readonly notebookId: NotebookId }> {}

/** Runs admitted work in FIFO order, independently for each notebook. */
export interface NotebookExecutor<R> {
  readonly submit: <A, E>(
    notebookId: NotebookId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E>;
  /** Like `submit`, but interrupts queued or running work when `scope` closes. */
  readonly submitIn: <A, E>(
    scope: Scope.Scope,
    notebookId: NotebookId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NotebookExecutionScopeClosedError>;
  readonly post: (
    notebookId: NotebookId,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void>;
  /** Like `post`, but interrupts queued or running work when `scope` closes. */
  readonly postIn: (
    scope: Scope.Scope,
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
      // Shutdown tracking: holds every actor whose worker has not finished,
      // including retired ones still draining after leaving `actors`.
      const live = new Set<Actor<R>>();

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
          const actor: Actor<R> = {
            queue,
            worker: yield* Effect.forkDetach(
              runWorker(queue).pipe(
                Effect.ensuring(Effect.sync(() => live.delete(actor))),
              ),
            ),
          };
          live.add(actor);
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
            // the coordinator before closing actors so all of them are routed.
            yield* Queue.end(ingress);
            yield* Fiber.join(coordinator);

            const currentActors = [...live];
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

      const inScope = <A, E, R2>(
        effect: Effect.Effect<A, E, R2>,
        scope: Scope.Scope,
        notebookId: NotebookId,
      ): Effect.Effect<A, E | NotebookExecutionScopeClosedError, R2> =>
        Effect.gen(function* () {
          if (Predicate.isTagged(scope.state, "Closed")) {
            return yield* new NotebookExecutionScopeClosedError({
              notebookId,
            });
          }
          const fiber = yield* Effect.forkIn(effect, scope, {
            startImmediately: true,
          });
          const exit = yield* Fiber.await(fiber).pipe(
            Effect.onInterrupt(() => Fiber.interrupt(fiber)),
          );
          if (
            Predicate.isTagged(scope.state, "Closed") &&
            Exit.isFailure(exit) &&
            Cause.hasInterruptsOnly(exit.cause)
          ) {
            return yield* new NotebookExecutionScopeClosedError({
              notebookId,
            });
          }
          return yield* exit;
        });

      const submitWork = <A, E>(
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

      const submit: NotebookExecutor<R>["submit"] = (notebookId, effect) =>
        submitWork(notebookId, effect);
      const submitIn: NotebookExecutor<R>["submitIn"] = (
        scope,
        notebookId,
        effect,
      ) => submitWork(notebookId, inScope(effect, scope, notebookId));

      const postWork = (
        notebookId: NotebookId,
        effect: Effect.Effect<void, never, R>,
      ) =>
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
      const post: NotebookExecutor<R>["post"] = (notebookId, effect) =>
        postWork(notebookId, effect);
      const postIn: NotebookExecutor<R>["postIn"] = (
        scope,
        notebookId,
        effect,
      ) =>
        postWork(
          notebookId,
          inScope(effect, scope, notebookId).pipe(
            Effect.catchTag(
              "NotebookExecutionScopeClosedError",
              () => Effect.void,
            ),
          ),
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

      return { submit, submitIn, post, postIn, retire };
    }),
  );
}
