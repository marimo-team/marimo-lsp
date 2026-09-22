import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Result } from "effect";

import {
  makeTestMarimoClient,
  type TestCommand,
} from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { kernelSessionId, notebookId } from "../../../lib/__tests__/branded.ts";
import { SessionNotFoundError, LiveSessions } from "../LiveSessions.ts";

const NOTEBOOK_URI = notebookId("file:///workspace/notebook.py");
const SESSION_ID = kernelSessionId("00000000-0000-4000-8000-000000000001");
const SNAPSHOT = {
  sessions: [
    {
      sessionId: SESSION_ID,
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

function makeLayer(recorded: TestCommand[], snapshot: unknown = SNAPSHOT) {
  return LiveSessions.layer.pipe(
    Layer.provide(
      makeTestMarimoClient({
        send: (request) =>
          Effect.sync(() => {
            recorded.push(request);
            return request.kind === "list-sessions" ? snapshot : null;
          }),
      }),
    ),
  );
}

it.effect(
  "decodes the authoritative session snapshot",
  Effect.fn(function* () {
    const recorded: TestCommand[] = [];

    const live = yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      return yield* sessions.get;
    }).pipe(Effect.provide(makeLayer(recorded)));

    expect(live).toEqual(SNAPSHOT.sessions);
    expect(recorded).toEqual([{ kind: "list-sessions" }]);
  }),
);

it.effect(
  "orders recorded sessions by start time, including re-execution of an older session",
  Effect.fn(function* () {
    const middle = SNAPSHOT.sessions[0];
    const older = {
      ...middle,
      notebookUri: notebookId("file:///older.py"),
      startedAt: 10,
    };
    const newer = {
      ...middle,
      notebookUri: notebookId("file:///newer.py"),
      startedAt: 100,
    };
    yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      yield* sessions.record(newer);
      yield* sessions.record({ ...older, status: "running" });
      const items = yield* sessions.get;
      expect(items.map((item) => item.notebookUri)).toEqual([
        newer.notebookUri,
        middle.notebookUri,
        older.notebookUri,
      ]);
      expect(items.at(-1)?.status).toBe("running");
    }).pipe(Effect.provide(makeLayer([], { sessions: [middle, older] })));
  }),
);

it.effect(
  "preserves the restarting status when recording an execution response",
  Effect.fn(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const layer = LiveSessions.layer.pipe(
      Layer.provide(
        makeTestMarimoClient({
          send: (request) =>
            request.kind === "restart-session"
              ? Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as(null),
                )
              : Effect.succeed(SNAPSHOT),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      const restart = yield* sessions
        .restart(NOTEBOOK_URI)
        .pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* sessions.record({ ...SNAPSHOT.sessions[0], status: "running" });
      expect(Option.getOrThrow(yield* sessions.find(NOTEBOOK_URI)).status).toBe(
        "restarting",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(restart);
      expect(Option.getOrThrow(yield* sessions.find(NOTEBOOK_URI)).status).toBe(
        "idle",
      );
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "shuts down every session and reconciles once",
  Effect.fn(function* () {
    const recorded: TestCommand[] = [];
    const secondNotebook = notebookId("file:///workspace/second.py");
    const snapshot = {
      sessions: [
        ...SNAPSHOT.sessions,
        {
          ...SNAPSHOT.sessions[0],
          sessionId: kernelSessionId("00000000-0000-4000-8000-000000000002"),
          notebookUri: secondNotebook,
          filename: "second.py",
        },
      ],
    };

    yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      yield* sessions.shutdownAll();
    }).pipe(Effect.provide(makeLayer(recorded, snapshot)));

    expect(recorded).toEqual([
      { kind: "list-sessions" },
      { kind: "shutdown-all-sessions" },
      { kind: "list-sessions" },
    ]);
  }),
);

it.effect(
  "returns no snapshot when a successful shutdown's follow-up query fails",
  Effect.fn(function* () {
    let closed = false;
    const layer = LiveSessions.layer.pipe(
      Layer.provide(
        makeTestMarimoClient({
          send: (request) =>
            Effect.sync(() => {
              if (request.kind === "close-session") closed = true;
              return request.kind === "list-sessions" && !closed
                ? SNAPSHOT
                : null;
            }),
        }),
      ),
    );
    yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      const result = yield* sessions.shutdown(NOTEBOOK_URI);
      expect(closed).toBe(true);
      expect(Option.isNone(result)).toBe(true);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "fails when a session disappears before restart",
  Effect.fn(function* () {
    const recorded: TestCommand[] = [];
    const result = yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      return yield* Effect.result(sessions.restart(NOTEBOOK_URI));
    }).pipe(Effect.provide(makeLayer(recorded, { sessions: [] })));

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toEqual(
        new SessionNotFoundError({ notebookUri: NOTEBOOK_URI }),
      );
    }
    expect(recorded).toEqual([{ kind: "list-sessions" }]);
  }),
);

it.effect(
  "restarts a session and reconciles with the server snapshot",
  Effect.fn(function* () {
    const recorded: TestCommand[] = [];

    yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      yield* sessions.restart(NOTEBOOK_URI);
    }).pipe(Effect.provide(makeLayer(recorded)));

    expect(recorded).toEqual([
      { kind: "list-sessions" },
      {
        kind: "restart-session",
        notebookUri: NOTEBOOK_URI,
        executable: "/venv/bin/python",
        workingDirectory: "/workspace",
      },
      { kind: "list-sessions" },
    ]);
  }),
);
