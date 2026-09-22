import {
  Cause,
  Context,
  Duration,
  Effect,
  Equal,
  Exit,
  Fiber,
  Hash,
  Layer,
  LayerMap,
  Predicate,
  Scope,
} from "effect";

import * as NotebookConfiguration from "../config/NotebookConfiguration.ts";
import * as NotebookDependencies from "./NotebookDependencies.ts";
import * as NotebookDocumentSessions from "./NotebookDocumentSessions.ts";
import { NotebookSession } from "./NotebookSession.ts";

/**
 * Compares sessions by their opaque identity without structurally hashing the
 * VS Code document carried by the session.
 */
class NotebookSessionKey implements Equal.Equal {
  readonly session: NotebookDocumentSessions.Session;
  constructor(session: NotebookDocumentSessions.Session) {
    this.session = session;
  }
  [Equal.symbol](that: unknown): boolean {
    return (
      that instanceof NotebookSessionKey && that.session.id === this.session.id
    );
  }
  [Hash.symbol](): number {
    return Hash.hash(this.session.id);
  }
}

const layerFor = (key: NotebookSessionKey) => {
  const sessionLayer = Layer.succeed(NotebookSession, key.session);
  return Layer.mergeAll(
    sessionLayer,
    NotebookConfiguration.layer.pipe(Layer.provide(sessionLayer)),
    NotebookDependencies.layer.pipe(Layer.provide(sessionLayer)),
  ).pipe(Layer.fresh);
};

type SessionServices =
  | NotebookSession
  | NotebookConfiguration.Service
  | NotebookDependencies.Service;

export interface Interface {
  readonly runScoped: <A, E, R>(
    session: NotebookDocumentSessions.Session,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<
    A,
    E | NotebookDocumentSessions.EndedError,
    Exclude<R, SessionServices> | Scope.Scope
  >;
}

/** Owns resources whose lifetime is one open notebook document session. */
export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookSessionResources",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const resources = yield* LayerMap.make(layerFor, {
      // A document-session end is the authoritative eviction signal.
      idleTimeToLive: Duration.infinity,
    });
    const registeredSessions = new WeakSet<NotebookDocumentSessions.Session>();

    const registerSession = Effect.fn(
      "NotebookSessionResources.registerSession",
    )(function* (session: NotebookDocumentSessions.Session) {
      yield* Effect.uninterruptible(
        Effect.suspend(() => {
          if (registeredSessions.has(session)) return Effect.void;
          registeredSessions.add(session);
          return Scope.addFinalizer(
            session.scope,
            resources.invalidate(new NotebookSessionKey(session)),
          );
        }),
      );
    });

    const contextFor = (session: NotebookDocumentSessions.Session) =>
      registerSession(session).pipe(
        Effect.andThen(
          resources.contextEffect(new NotebookSessionKey(session)),
        ),
      );

    const runInSessionScope = <A, E, R>(
      session: NotebookDocumentSessions.Session,
      makeEffect: (scope: Scope.Scope) => Effect.Effect<A, E, R>,
    ): Effect.Effect<
      A,
      E | NotebookDocumentSessions.EndedError,
      R | Scope.Scope
    > =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        if (scope !== session.scope) {
          return yield* Effect.die(
            "NotebookSessionResources.runScoped must be provided the session scope",
          );
        }
        if (Predicate.isTagged(scope.state, "Closed")) {
          return yield* new NotebookDocumentSessions.EndedError({
            notebookId: session.notebookId,
          });
        }

        const fiber = yield* Effect.forkIn(makeEffect(scope), scope, {
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
          return yield* new NotebookDocumentSessions.EndedError({
            notebookId: session.notebookId,
          });
        }
        return yield* exit;
      });

    const runScoped = Effect.fn("NotebookSessionResources.runScoped")(
      function* <A, E, R>(
        session: NotebookDocumentSessions.Session,
        effect: Effect.Effect<A, E, R>,
      ) {
        return yield* runInSessionScope(session, (scope) =>
          Effect.scoped(
            contextFor(session).pipe(
              Effect.flatMap((context) =>
                Effect.provide(effect, context).pipe(Scope.provide(scope)),
              ),
            ),
          ),
        );
      },
    );

    return Service.of({ runScoped });
  }),
);
