import { expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  PubSub,
  Result,
  Stream,
} from "effect";

import {
  makeTestMarimoClient,
  type TestCommand,
} from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { kernelSessionId, notebookId } from "../../../lib/__tests__/branded.ts";
import type { ListSessionsResponse } from "../../../schemas/Models.gen.ts";
import * as LiveSessions from "../LiveSessions.ts";

const NOTEBOOK_URI = notebookId("file:///workspace/notebook.py");
const SNAPSHOT = {
  generation: 1,
  revision: 1,
  sessions: [
    {
      sessionId: kernelSessionId("00000000-0000-4000-8000-000000000001"),
      notebookUri: NOTEBOOK_URI,
      filename: "notebook.py",
      executable: "/venv/bin/python",
      workingDirectory: "/workspace",
      startedAt: 42,
      status: "idle",
      attached: false,
    },
  ],
} as const;

const makeLayer = (options: Parameters<typeof makeTestMarimoClient>[0]) =>
  LiveSessions.layer.pipe(Layer.provide(makeTestMarimoClient(options)));

it.effect(
  "does not resurrect a closed session when an earlier query returns late",
  Effect.fn(function* () {
    const changes = yield* PubSub.unbounded<ListSessionsResponse>();
    const queryStarted = yield* Deferred.make<void>();
    const releaseQuery = yield* Deferred.make<void>();
    let queries = 0;
    const layer = makeLayer({
      sessionChanges: Stream.fromPubSub(changes),
      send: () =>
        Effect.gen(function* () {
          if (++queries > 1) {
            yield* Deferred.succeed(queryStarted, undefined);
            yield* Deferred.await(releaseQuery);
          }
          return SNAPSHOT;
        }),
    });
    yield* Effect.gen(function* () {
      const live = yield* LiveSessions.Service;
      const refresh = yield* live.refresh.pipe(Effect.forkChild);
      yield* Deferred.await(queryStarted);
      const closed = yield* live.changes.pipe(
        Stream.filter((items) => items.length === 0),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* PubSub.publish(changes, {
        ...SNAPSHOT,
        revision: 2,
        sessions: [],
      });
      yield* Fiber.join(closed);
      yield* Deferred.succeed(releaseQuery, undefined);
      expect(yield* Fiber.join(refresh)).toEqual([]);
      expect(yield* live.get).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([
  { generation: 1, revision: 100 },
  { generation: 2, revision: 0 },
  { generation: 2, revision: 1 },
])("ignores older or duplicate state after a server restart (%j)", (version) =>
  Effect.gen(function* () {
    yield* Effect.gen(function* () {
      const live = yield* LiveSessions.Service;
      yield* live.accept({ ...SNAPSHOT, revision: 50 });
      yield* live.accept({ generation: 2, revision: 1, sessions: [] });
      yield* live.accept({ ...SNAPSHOT, ...version });
      expect(yield* live.get).toEqual([]);
    }).pipe(
      Effect.provide(makeLayer({ send: () => Effect.succeed(SNAPSHOT) })),
    );
  }),
);

it.effect(
  "keeps restarting as a view overlay and shows the latest status when restart finishes",
  Effect.fn(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const replacement = {
      ...SNAPSHOT,
      revision: 3,
      sessions: [
        {
          ...SNAPSHOT.sessions[0],
          sessionId: kernelSessionId("00000000-0000-4000-8000-000000000002"),
          status: "running" as const,
        },
      ],
    };
    const layer = makeLayer({
      send: (request) =>
        request.kind === "restart-session"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Deferred.await(release)),
              Effect.as({ ...SNAPSHOT, revision: 2 }),
            )
          : Effect.succeed(SNAPSHOT),
    });
    yield* Effect.gen(function* () {
      const live = yield* LiveSessions.Service;
      const restart = yield* live.restart(NOTEBOOK_URI).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* live.accept(replacement);
      expect(Option.getOrThrow(yield* live.find(NOTEBOOK_URI))).toMatchObject({
        sessionId: replacement.sessions[0]?.sessionId,
        status: "restarting",
      });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(restart);
      expect(yield* live.get).toEqual(replacement.sessions);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "does not restore a dead session when restart is interrupted",
  Effect.fn(function* () {
    const started = yield* Deferred.make<void>();
    const layer = makeLayer({
      send: (request) =>
        request.kind === "restart-session"
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
            )
          : Effect.succeed(SNAPSHOT),
    });
    yield* Effect.gen(function* () {
      const live = yield* LiveSessions.Service;
      const restart = yield* live.restart(NOTEBOOK_URI).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* live.accept({ ...SNAPSHOT, revision: 2, sessions: [] });
      yield* Fiber.interrupt(restart);
      expect(yield* live.get).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each(["shutdown", "shutdownAll"] as const)(
  "%s applies its response without a follow-up query",
  (method) =>
    Effect.gen(function* () {
      const recorded: TestCommand[] = [];
      yield* Effect.gen(function* () {
        const live = yield* LiveSessions.Service;
        yield* method === "shutdown"
          ? live.shutdown(NOTEBOOK_URI)
          : live.shutdownAll;
        expect(yield* live.get).toEqual([]);
      }).pipe(
        Effect.provide(
          makeLayer({
            send: (request) =>
              Effect.sync(() => {
                recorded.push(request);
                if (request.kind === "list-sessions") {
                  // A second list request fails decoding instead of hiding the regression.
                  return recorded.length === 1 ? SNAPSHOT : null;
                }
                return { ...SNAPSHOT, revision: 2, sessions: [] };
              }),
          }),
        ),
      );
      expect(recorded.map((request) => request.kind)).toEqual([
        "list-sessions",
        method === "shutdown" ? "close-session" : "shutdown-all-sessions",
      ]);
    }),
);

it.effect(
  "fails when a session disappears before restart",
  Effect.fn(function* () {
    const result = yield* Effect.gen(function* () {
      const live = yield* LiveSessions.Service;
      return yield* Effect.result(live.restart(NOTEBOOK_URI));
    }).pipe(
      Effect.provide(
        makeLayer({
          send: () => Effect.succeed({ ...SNAPSHOT, sessions: [] }),
        }),
      ),
    );
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toEqual(
        new LiveSessions.NotFoundError({ notebookUri: NOTEBOOK_URI }),
      );
    }
  }),
);
