import {
  Context,
  Duration,
  Effect,
  Equal,
  Hash,
  Layer,
  LayerMap,
  Scope,
  Stream,
} from "effect";

import { NotebookConfiguration } from "../config/NotebookConfiguration.ts";
import { NotebookDependencies } from "./NotebookDependencies.ts";
import type { NotebookDocumentSession } from "./NotebookDocumentSessions.ts";
import { NotebookSession } from "./NotebookSession.ts";

/**
 * Compares sessions by their opaque identity without structurally hashing the
 * VS Code document carried by the session.
 */
class NotebookSessionKey implements Equal.Equal {
  readonly session: NotebookDocumentSession;
  constructor(session: NotebookDocumentSession) {
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

/** Owns resources whose lifetime is one open notebook document session. */
export class NotebookSessionResources extends Context.Service<NotebookSessionResources>()(
  "NotebookSessionResources",
  {
    make: Effect.gen(function* () {
      const resources = yield* LayerMap.make(layerFor, {
        // A document-session end is the authoritative eviction signal.
        idleTimeToLive: Duration.infinity,
      });
      const registeredSessions = new WeakSet<NotebookDocumentSession>();

      const registerSession = Effect.fn(
        "NotebookSessionResources.registerSession",
      )((session: NotebookDocumentSession) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            if (registeredSessions.has(session)) return Effect.void;
            registeredSessions.add(session);
            return Scope.addFinalizer(
              session.scope,
              resources.invalidate(new NotebookSessionKey(session)),
            );
          }),
        ),
      );

      const contextFor = (session: NotebookDocumentSession) =>
        resources
          .contextEffect(new NotebookSessionKey(session))
          .pipe(Effect.tap(() => registerSession(session)));

      return {
        run<A, E, R>(
          session: NotebookDocumentSession,
          effect: Effect.Effect<A, E, R>,
        ) {
          return Effect.scoped(
            contextFor(session).pipe(
              Effect.flatMap((context) => Effect.provide(effect, context)),
            ),
          );
        },
        stream<A, E, R>(
          session: NotebookDocumentSession,
          stream: Stream.Stream<A, E, R>,
        ) {
          return Stream.unwrap(
            contextFor(session).pipe(
              Effect.map((context) => Stream.provide(stream, context)),
            ),
          );
        },
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
