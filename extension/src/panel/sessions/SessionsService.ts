import {
  Effect,
  Option,
  Schedule,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";

import { MarimoClient } from "../../lsp/MarimoClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import { type SessionInfo, SessionsSnapshot } from "./schemas.ts";

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

      const find = (notebookUri: NotebookId) =>
        Effect.map(SubscriptionRef.get(sessions), (items) =>
          Option.fromNullable(
            items.find((item) => item.notebookUri === notebookUri),
          ),
        );

      const restart = Effect.fn("SessionsService.restart")(function* (
        notebookUri: NotebookId,
      ) {
        const current = yield* find(notebookUri);
        if (Option.isNone(current)) return;
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
          .pipe(Effect.tapError(() => refresh()));
        yield* refresh();
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
          yield* marimo
            .restartSession({
              notebookUri,
              inner: { executable, workingDirectory },
            })
            .pipe(
              Effect.retry(
                Schedule.spaced("100 millis").pipe(
                  Schedule.intersect(Schedule.recurs(10)),
                ),
              ),
            );
          yield* refresh();
        }),
        shutdownAll: Effect.fn("SessionsService.shutdownAll")(function* () {
          const live = yield* SubscriptionRef.get(sessions);
          yield* Effect.forEach(
            live,
            (session) => shutdown(session.notebookUri),
            {
              discard: true,
            },
          );
        }),
        move,
      };
    }),
  },
) {}
