import {
  Cause,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FiberSet,
  Predicate,
  Queue,
  Scope,
} from "effect";
import type { TaggedEnum } from "effect/Data";

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

type Ingress<R> = Data.TaggedEnum<{
  Work: { readonly work: Work<R> };
  Idle: {
    readonly notebookId: NotebookId;
    readonly actor: Actor<R>;
    readonly retire: Deferred.Deferred<boolean>;
  };
}>;
interface IngressDef extends TaggedEnum.WithGenerics<1> {
  readonly taggedEnum: Ingress<this["A"]>;
}
const Ingress = Data.taggedEnum<IngressDef>();

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
  /** Like `submit`, but owned by the `Scope` in the Effect environment. */
  readonly submitScoped: <A, E>(
    notebookId: NotebookId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E | NotebookExecutionScopeClosedError, Scope.Scope>;
  readonly post: (
    notebookId: NotebookId,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void>;
  /** Like `post`, but owned by the `Scope` in the Effect environment. */
  readonly postScoped: (
    notebookId: NotebookId,
    effect: Effect.Effect<void, never, R>,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** Makes a scoped executor that owns every successfully admitted effect. */
export function makeNotebookExecutor<R>(): Effect.Effect<
  NotebookExecutor<R>,
  never,
  R | Scope.Scope
> {
  return Effect.uninterruptible(
    Effect.gen(function* () {
      const ingress = yield* Queue.unbounded<Ingress<R>, Cause.Done>();
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

      const runWorker = (notebookId: NotebookId, actor: Actor<R>) => {
        const loop = (): Effect.Effect<void, Cause.Done, R> =>
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const work = yield* restore(Queue.take(actor.queue));
              yield* work
                .run(restore)
                .pipe(
                  Effect.catchCause((cause) =>
                    Cause.hasInterruptsOnly(cause)
                      ? Effect.void
                      : Effect.logError("Notebook executor event failed").pipe(
                          Effect.annotateLogs({ cause }),
                        ),
                  ),
                );

              if ((yield* Queue.size(actor.queue)) > 0) return false;
              const retire = yield* Deferred.make<boolean>();
              const offered = yield* Queue.offer(
                ingress,
                Ingress.Idle({ notebookId, actor, retire }),
              );
              return offered ? yield* Deferred.await(retire) : true;
            }),
          ).pipe(
            Effect.flatMap((retire) =>
              retire ? Effect.void : Effect.suspend(loop),
            ),
          );
        return loop().pipe(Effect.catchTag("Done", () => Effect.void));
      };

      const actorFor = (notebookId: NotebookId) =>
        Effect.gen(function* () {
          const current = actors.get(notebookId);
          if (current !== undefined) return current;

          const queue = yield* Queue.unbounded<Work<R>, Cause.Done>();
          const actor: Actor<R> = { queue };
          actors.set(notebookId, actor);
          yield* FiberSet.run(
            fibers,
            runWorker(notebookId, actor).pipe(
              Effect.ensuring(closeActor(notebookId, actor)),
            ),
          );
          return actor;
        });

      const coordinator = yield* FiberSet.run(
        fibers,
        Effect.forever(
          Queue.take(ingress).pipe(
            Effect.flatMap((message) =>
              Ingress.$is("Work")(message)
                ? Effect.gen(function* () {
                    const { work } = message;
                    const actor = yield* actorFor(work.notebookId);
                    if (!(yield* Queue.offer(actor.queue, work))) {
                      const fresh = yield* actorFor(work.notebookId);
                      if (!(yield* Queue.offer(fresh.queue, work))) {
                        yield* work.reject;
                      }
                    }
                  })
                : Effect.gen(function* () {
                    const current = actors.get(message.notebookId);
                    const shouldRetire =
                      current !== message.actor ||
                      (yield* Queue.size(message.actor.queue)) === 0;
                    if (shouldRetire && current === message.actor) {
                      actors.delete(message.notebookId);
                      yield* Queue.end(message.actor.queue);
                    }
                    yield* Deferred.succeed(message.retire, shouldRetire);
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

            if (!(yield* Queue.offer(ingress, Ingress.Work({ work })))) {
              yield* work.reject;
            }

            // A successful offer transfers ownership to the executor. Caller
            // interruption only stops waiting for the reply.
            return yield* restore(Deferred.await(reply));
          }),
        );

      const submit: NotebookExecutor<R>["submit"] = (notebookId, effect) =>
        submitWork(notebookId, effect);
      const submitScoped: NotebookExecutor<R>["submitScoped"] = (
        notebookId,
        effect,
      ) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          const watcherScope = yield* Scope.fork(scope);
          const closed = yield* Deferred.make<void>();
          yield* Scope.addFinalizer(
            watcherScope,
            Deferred.succeed(closed, undefined),
          );
          return yield* Effect.raceFirst(
            submitWork(notebookId, inScope(effect, scope, notebookId)),
            Deferred.await(closed).pipe(
              Effect.andThen(
                Effect.fail(
                  new NotebookExecutionScopeClosedError({ notebookId }),
                ),
              ),
            ),
          ).pipe(Effect.ensuring(Scope.close(watcherScope, Exit.void)));
        });

      const postWork = (
        notebookId: NotebookId,
        effect: Effect.Effect<void, never, R>,
      ) =>
        Effect.uninterruptible(
          Effect.gen(function* () {
            const admitted = yield* Queue.offer(
              ingress,
              Ingress.Work({
                work: {
                  notebookId,
                  run: (restore) => restore(effect),
                  reject: Effect.void,
                },
              }),
            );
            if (!admitted) return yield* Effect.interrupt;
            return undefined;
          }),
        );
      const post: NotebookExecutor<R>["post"] = (notebookId, effect) =>
        postWork(notebookId, effect);
      const postScoped: NotebookExecutor<R>["postScoped"] = (
        notebookId,
        effect,
      ) =>
        Effect.gen(function* () {
          const scope = yield* Effect.scope;
          yield* postWork(
            notebookId,
            inScope(effect, scope, notebookId).pipe(
              Effect.catchTag(
                "NotebookExecutionScopeClosedError",
                () => Effect.void,
              ),
            ),
          );
        });

      return { submit, submitScoped, post, postScoped };
    }),
  );
}
