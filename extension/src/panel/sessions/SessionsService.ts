import { Data, Effect, Option, Schema, Stream, SubscriptionRef } from "effect";

import { MarimoClient } from "../../lsp/MarimoClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import { type SessionInfo, SessionsSnapshot } from "./schemas.ts";

export class SessionNotFoundError extends Data.TaggedError(
  "SessionNotFoundError",
)<{ readonly notebookUri: NotebookId }> {}

export type SessionViewStatus = SessionInfo["status"] | "restarting";
export type SessionViewItem = Omit<SessionInfo, "status"> & {
  readonly status: SessionViewStatus;
};

/** Authoritative live-session state shared by the tree and future renderers. */
export class SessionsService extends Effect.Service<SessionsService>()(
  "SessionsService",
  {
    scoped: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const sessions = yield* SubscriptionRef.make<
        ReadonlyArray<SessionViewItem>
      >([]);

      const applySnapshot = Effect.fn("SessionsService.applySnapshot")(
        function* (snapshot: unknown) {
          const decoded =
            yield* Schema.decodeUnknown(SessionsSnapshot)(snapshot);
          yield* SubscriptionRef.set(sessions, decoded.sessions);
        },
      );

      const refresh = Effect.fn("SessionsService.refresh")(function* () {
        yield* applySnapshot(yield* marimo.listSessions({}));
      });

      yield* Effect.forkScoped(
        marimo
          .sessionChanges()
          .pipe(
            Stream.runForEach((snapshot) =>
              applySnapshot(snapshot).pipe(
                Effect.catchAllCause((cause) =>
                  Effect.logWarning(
                    "Ignored invalid live-session snapshot",
                  ).pipe(Effect.annotateLogs({ cause })),
                ),
              ),
            ),
          ),
      );

      // Subscribe before pulling the initial snapshot so a concurrent server
      // mutation cannot be lost between the list request and registration.
      yield* refresh().pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning("Failed to load initial live sessions").pipe(
            Effect.annotateLogs({ cause }),
          ),
        ),
      );

      const find = (notebookUri: NotebookId) =>
        Effect.map(SubscriptionRef.get(sessions), (items) =>
          Option.fromNullishOr(
            items.find((item) => item.notebookUri === notebookUri),
          ),
        );

      const restart = Effect.fn("SessionsService.restart")(function* (
        notebookUri: NotebookId,
      ) {
        const current = yield* find(notebookUri);
        if (Option.isNone(current)) {
          return yield* new SessionNotFoundError({ notebookUri });
        }
        yield* SubscriptionRef.update(sessions, (items) =>
          items.map((item) =>
            item.notebookUri === notebookUri
              ? { ...item, status: "restarting" as const }
              : item,
          ),
        );
        yield* marimo
          .restartSession({
            notebookUri,
            inner: {
              executable: current.value.executable,
              workingDirectory: current.value.workingDirectory,
            },
          })
          .pipe(
            Effect.tapError(() =>
              SubscriptionRef.update(sessions, (items) =>
                items.map((item) =>
                  item.notebookUri === notebookUri ? current.value : item,
                ),
              ),
            ),
          );
        yield* SubscriptionRef.update(sessions, (items) =>
          items.map((item) =>
            item.notebookUri === notebookUri
              ? { ...item, status: "idle" as const }
              : item,
          ),
        );
        yield* refresh().pipe(
          Effect.catchAllCause((cause) =>
            Effect.logWarning(
              "Failed to reconcile live sessions after restart",
            ).pipe(Effect.annotateLogs({ cause, notebookUri })),
          ),
        );
        return undefined;
      });

      const shutdown = Effect.fn("SessionsService.shutdown")(function* (
        notebookUri: NotebookId,
      ) {
        yield* marimo.closeSession({ notebookUri, inner: {} });
        yield* refresh();
      });

      const move = Effect.fn("SessionsService.move")(function* (
        notebookUri: NotebookId,
        newNotebookUri: NotebookId,
      ) {
        yield* marimo.moveSession({
          notebookUri,
          inner: { newNotebookUri },
        });
        yield* refresh();
      });

      return {
        get: () => SubscriptionRef.get(sessions),
        changes: () => sessions.changes,
        find,
        refresh,
        restart,
        shutdown,
        restore: Effect.fn("SessionsService.restore")(function* (
          notebookUri: NotebookId,
          executable: string,
          workingDirectory: string,
        ) {
          yield* marimo.restartSession({
            notebookUri,
            inner: {
              executable,
              workingDirectory,
              createIfMissing: true,
            },
          });
          yield* refresh();
        }),
        shutdownAll: Effect.fn("SessionsService.shutdownAll")(function* () {
          yield* marimo.shutdownAllSessions({});
          yield* refresh();
        }),
        move,
      };
    }),
  },
) {}
