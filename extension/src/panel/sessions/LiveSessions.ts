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

import * as MarimoClient from "../../lsp/MarimoClient.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import {
  type SessionInfo,
  ListSessionsResponse,
} from "../../schemas/Models.gen.ts";

export class NotFoundError extends Data.TaggedError(
  "LiveSessions.NotFoundError",
)<{ readonly notebookUri: NotebookId }> {}

export type Status = SessionInfo["status"] | "restarting";
export type Item = Omit<SessionInfo, "status"> & {
  readonly status: Status;
};

type CommandError = MarimoClient.Error | Schema.SchemaError;

export interface Interface {
  readonly get: Effect.Effect<ReadonlyArray<Item>>;
  readonly changes: Stream.Stream<ReadonlyArray<Item>>;
  readonly find: (
    notebookUri: NotebookId,
  ) => Effect.Effect<Option.Option<Item>>;
  readonly refresh: Effect.Effect<ReadonlyArray<SessionInfo>, CommandError>;
  readonly accept: (
    snapshot: ListSessionsResponse,
  ) => Effect.Effect<ReadonlyArray<SessionInfo>>;
  readonly restart: (
    notebookUri: NotebookId,
  ) => Effect.Effect<ReadonlyArray<SessionInfo>, NotFoundError | CommandError>;
  readonly shutdown: (
    notebookUri: NotebookId,
  ) => Effect.Effect<ReadonlyArray<SessionInfo>, CommandError>;
  readonly restore: (
    notebookUri: NotebookId,
    executable: string,
    workingDirectory: string,
  ) => Effect.Effect<ReadonlyArray<SessionInfo>, CommandError>;
  readonly shutdownAll: Effect.Effect<ReadonlyArray<SessionInfo>, CommandError>;
  readonly move: (
    notebookUri: NotebookId,
    newNotebookUri: NotebookId,
  ) => Effect.Effect<ReadonlyArray<SessionInfo>, CommandError>;
}

interface SessionState {
  readonly snapshot: ListSessionsResponse;
  readonly restarting: ReadonlySet<NotebookId>;
}

const view = ({ snapshot, restarting }: SessionState): ReadonlyArray<Item> =>
  snapshot.sessions.map((session) =>
    restarting.has(session.notebookUri)
      ? { ...session, status: "restarting" }
      : session,
  );

/** Server snapshots are authoritative; pending restarts only affect presentation. */
export class Service extends Context.Service<Service, Interface>()(
  "@marimo/LiveSessions",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const marimo = yield* MarimoClient.Service;
    const state = yield* SubscriptionRef.make<SessionState>({
      snapshot: { generation: -1, revision: 0, sessions: [] },
      restarting: new Set(),
    });

    const accept = Effect.fn("LiveSessions.accept")(
      (snapshot: ListSessionsResponse) =>
        SubscriptionRef.updateAndGet(state, (current) => {
          const previous = current.snapshot;
          if (
            snapshot.generation < previous.generation ||
            (snapshot.generation === previous.generation &&
              snapshot.revision <= previous.revision)
          ) {
            return current;
          }
          return { ...current, snapshot };
        }).pipe(Effect.map((current) => current.snapshot.sessions)),
    );

    const refresh = marimo
      .listSessions({})
      .pipe(Effect.flatMap(accept), Effect.withSpan("LiveSessions.refresh"));

    yield* Effect.forkScoped(
      marimo.sessionChanges.pipe(
        Stream.runForEach((snapshot) =>
          Schema.decodeUnknownEffect(ListSessionsResponse)(snapshot).pipe(
            Effect.flatMap(accept),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logWarning(
                    "Ignored invalid live-session snapshot",
                  ).pipe(Effect.annotateLogs({ cause })),
            ),
          ),
        ),
      ),
    );

    // Subscribe first so changes during the initial query are not missed.
    // Revisions order responses and notifications regardless of scheduling.
    yield* refresh.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Failed to load initial live sessions").pipe(
              Effect.annotateLogs({ cause }),
            ),
      ),
    );

    const get = SubscriptionRef.get(state).pipe(Effect.map(view));
    const find = (notebookUri: NotebookId) =>
      Effect.map(get, (items) =>
        Option.fromNullishOr(
          items.find((item) => item.notebookUri === notebookUri),
        ),
      );

    const restart = Effect.fn("LiveSessions.restart")(function* (
      notebookUri: NotebookId,
    ) {
      const current = yield* find(notebookUri);
      if (Option.isNone(current)) {
        return yield* new NotFoundError({ notebookUri });
      }
      return yield* Effect.acquireUseRelease(
        SubscriptionRef.update(state, (current) => ({
          ...current,
          restarting: new Set([...current.restarting, notebookUri]),
        })),
        () =>
          marimo
            .restartSession({
              notebookUri,
              executable: current.value.executable,
              workingDirectory: current.value.workingDirectory,
            })
            .pipe(Effect.flatMap(accept)),
        () =>
          SubscriptionRef.update(state, (current) => ({
            ...current,
            restarting: new Set(
              [...current.restarting].filter((id) => id !== notebookUri),
            ),
          })),
      );
    });

    const shutdown = Effect.fn("LiveSessions.shutdown")(
      (notebookUri: NotebookId) =>
        marimo.closeSession({ notebookUri }).pipe(Effect.flatMap(accept)),
    );
    const restore = Effect.fn("LiveSessions.restore")(
      (notebookUri: NotebookId, executable: string, workingDirectory: string) =>
        marimo
          .restartSession({
            notebookUri,
            executable,
            workingDirectory,
            createIfMissing: true,
          })
          .pipe(Effect.flatMap(accept)),
    );
    const shutdownAll = marimo
      .shutdownAllSessions({})
      .pipe(
        Effect.flatMap(accept),
        Effect.withSpan("LiveSessions.shutdownAll"),
      );
    const move = Effect.fn("LiveSessions.move")(
      (notebookUri: NotebookId, newNotebookUri: NotebookId) =>
        marimo
          .moveSession({ notebookUri, newNotebookUri })
          .pipe(Effect.flatMap(accept)),
    );

    return Service.of({
      get,
      changes: SubscriptionRef.changes(state).pipe(
        Stream.changes,
        Stream.map(view),
      ),
      find,
      refresh,
      accept,
      restart,
      shutdown,
      restore,
      shutdownAll,
      move,
    });
  }),
);
