import {
  Effect,
  Exit,
  HashMap,
  Option,
  PubSub,
  Scope,
  Stream,
  SynchronizedRef,
} from "effect";

import { LanguageClient } from "../lsp/LanguageClient.ts";
import type { NotebookId } from "../schemas/MarimoNotebookDocument.ts";
import type { MarimoLspNotificationOf, Notification } from "../types.ts";

export type MarimoOperation = MarimoLspNotificationOf<"marimo/operation">;

/**
 * One live marimo runtime, identified by its notebook URI.
 *
 * Operations are ordered as received from the language server. The stream ends
 * when this session is closed.
 */
export interface RuntimeSession {
  readonly notebookUri: NotebookId;
  readonly operations: () => Stream.Stream<Notification>;
  readonly shutdown: () => Effect.Effect<void>;
}

interface SessionEntry {
  readonly token: object;
  readonly session: RuntimeSession;
  readonly operations: PubSub.PubSub<Notification>;
  readonly scope: Scope.CloseableScope;
}

/**
 * Owns live runtime sessions and the extension's single subscription to
 * `marimo/operation`.
 *
 * `getOrCreate` returns the current session for a notebook URI. Shutting down
 * the session ends its operation stream and removes it from the registry. A
 * later `getOrCreate` creates a fresh session.
 */
export class RuntimeSessions extends Effect.Service<RuntimeSessions>()(
  "RuntimeSessions",
  {
    scoped: Effect.gen(function* () {
      const client = yield* LanguageClient;
      const allOperations = yield* PubSub.unbounded<MarimoOperation>();
      const sessions = yield* SynchronizedRef.make(
        HashMap.empty<NotebookId, SessionEntry>(),
      );

      const shutdown = Effect.fn("RuntimeSessions.shutdown")(function* (
        notebookUri: NotebookId,
        token: object,
      ) {
        yield* SynchronizedRef.updateEffect(
          sessions,
          Effect.fnUntraced(function* (entries) {
            const entry = HashMap.get(entries, notebookUri);
            if (Option.isNone(entry) || entry.value.token !== token) {
              return entries;
            }

            yield* Scope.close(entry.value.scope, Exit.void);
            return HashMap.remove(entries, notebookUri);
          }),
        );
      });

      const makeSession = Effect.fn("RuntimeSessions.makeSession")(function* (
        notebookUri: NotebookId,
      ) {
        const token = {};
        const scope = yield* Scope.make();
        const operations = yield* Scope.extend(
          Effect.gen(function* () {
            const operations = yield* PubSub.unbounded<Notification>();
            yield* Effect.addFinalizer(() => PubSub.shutdown(operations));
            return operations;
          }),
          scope,
        );
        const session: RuntimeSession = {
          notebookUri,
          operations: () => Stream.fromPubSub(operations),
          shutdown: () => shutdown(notebookUri, token),
        };
        return { token, session, operations, scope } satisfies SessionEntry;
      });

      const getOrCreate = Effect.fn("RuntimeSessions.getOrCreate")(function* (
        notebookUri: NotebookId,
      ) {
        return yield* SynchronizedRef.modifyEffect(
          sessions,
          Effect.fnUntraced(function* (entries) {
            const existing = HashMap.get(entries, notebookUri);
            if (Option.isSome(existing)) {
              return [existing.value.session, entries] as const;
            }

            const entry = yield* makeSession(notebookUri);
            return [
              entry.session,
              HashMap.set(entries, notebookUri, entry),
            ] as const;
          }),
        );
      });

      yield* Effect.forkScoped(
        client.streamOf("marimo/operation").pipe(
          Stream.runForEach(
            Effect.fn("RuntimeSessions.routeOperation")(function* (message) {
              yield* PubSub.publish(allOperations, message);

              const entry = HashMap.get(
                yield* SynchronizedRef.get(sessions),
                message.notebookUri,
              );
              if (Option.isSome(entry)) {
                yield* PubSub.publish(
                  entry.value.operations,
                  message.operation,
                );
              }
            }),
          ),
        ),
      );

      yield* Effect.addFinalizer((exit) =>
        SynchronizedRef.updateEffect(
          sessions,
          Effect.fnUntraced(function* (entries) {
            yield* Effect.forEach(
              HashMap.values(entries),
              (entry) => Scope.close(entry.scope, exit),
              { discard: true },
            );
            return HashMap.empty();
          }),
        ).pipe(Effect.andThen(PubSub.shutdown(allOperations))),
      );

      return {
        getOrCreate,
        operations: () => Stream.fromPubSub(allOperations),
      };
    }),
  },
) {}
