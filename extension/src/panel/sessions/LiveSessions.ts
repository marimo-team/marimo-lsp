import {
  Cause,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";

import { MarimoClient } from "../../lsp/MarimoClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import {
  type SessionInfo,
  ListSessionsResponse,
} from "../../schemas/Models.gen.ts";

export class SessionNotFoundError extends Data.TaggedError(
  "SessionNotFoundError",
)<{ readonly notebookUri: NotebookId }> {}

export type SessionViewStatus = SessionInfo["status"] | "restarting";
export type SessionViewItem = Omit<SessionInfo, "status"> & {
  readonly status: SessionViewStatus;
};

/** Authoritative live-session state shared by the tree and future renderers. */
export class LiveSessions extends Context.Service<LiveSessions>()(
  "LiveSessions",
  {
    make: Effect.gen(function* () {
      const marimo = yield* MarimoClient;
      const sessions = yield* SubscriptionRef.make<
        ReadonlyArray<SessionViewItem>
      >([]);

      const applySnapshot = Effect.fn("LiveSessions.applySnapshot")(function* (
        snapshot: ReadonlyArray<SessionInfo>,
      ) {
        yield* SubscriptionRef.set(sessions, snapshot);
        return snapshot;
      });

      const refresh = Effect.fn("LiveSessions.refresh")(function* () {
        return yield* applySnapshot((yield* marimo.listSessions({})).sessions);
      });

      // A failed follow-up query must not turn a successful mutation into an error.
      const refreshAfterMutation = refresh().pipe(
        Effect.map(Option.some),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning(
                "Failed to refresh sessions after kernel mutation",
              ).pipe(
                Effect.annotateLogs({ cause }),
                Effect.as(Option.none<ReadonlyArray<SessionInfo>>()),
              ),
        ),
      );

      yield* Effect.forkScoped(
        marimo.sessionChanges.pipe(
          Stream.runForEach((snapshot) =>
            Schema.decodeUnknownEffect(ListSessionsResponse)(snapshot).pipe(
              Effect.flatMap((decoded) => applySnapshot(decoded.sessions)),
              Effect.catchCause((cause) =>
                Effect.logWarning("Ignored invalid live-session snapshot").pipe(
                  Effect.annotateLogs({ cause }),
                ),
              ),
            ),
          ),
        ),
      );

      // Subscribe before querying for sessions that are already running. The
      // server constructs this response after earlier notifications on the wire;
      // consumers still need to account for independent stream scheduling.
      yield* refresh().pipe(
        Effect.catchCause((cause) =>
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

      const restart = Effect.fn("LiveSessions.restart")(function* (
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
            executable: current.value.executable,
            workingDirectory: current.value.workingDirectory,
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
        return yield* refreshAfterMutation;
      });

      const shutdown = Effect.fn("LiveSessions.shutdown")(function* (
        notebookUri: NotebookId,
      ) {
        yield* marimo.closeSession({ notebookUri });
        return yield* refreshAfterMutation;
      });

      const move = Effect.fn("LiveSessions.move")(function* (
        notebookUri: NotebookId,
        newNotebookUri: NotebookId,
      ) {
        yield* marimo.moveSession({
          notebookUri,
          newNotebookUri,
        });
        return yield* refreshAfterMutation;
      });

      return {
        get: SubscriptionRef.get(sessions),
        changes: SubscriptionRef.changes(sessions),
        find,
        refresh,
        record: Effect.fn("LiveSessions.record")(function* (
          session: SessionInfo,
        ) {
          yield* SubscriptionRef.update(sessions, (items) => {
            const current = items.find(
              (item) => item.notebookUri === session.notebookUri,
            );
            const next: SessionViewItem =
              current?.status === "restarting"
                ? { ...session, status: "restarting" }
                : session;
            return [
              ...items.filter(
                (item) => item.notebookUri !== session.notebookUri,
              ),
              next,
            ].sort((a, b) => b.startedAt - a.startedAt);
          });
        }),
        restart,
        shutdown,
        restore: Effect.fn("LiveSessions.restore")(function* (
          notebookUri: NotebookId,
          executable: string,
          workingDirectory: string,
        ) {
          yield* marimo.restartSession({
            notebookUri,
            executable,
            workingDirectory,
            createIfMissing: true,
          });
          return yield* refreshAfterMutation;
        }),
        shutdownAll: Effect.fn("LiveSessions.shutdownAll")(function* () {
          yield* marimo.shutdownAllSessions({});
          return yield* refreshAfterMutation;
        }),
        move,
      };
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
