import { expect, it } from "@effect/vitest";
import { Effect, Layer, Result } from "effect";

import { makeTestMarimoClient } from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { kernelSessionId, notebookId } from "../../../lib/__tests__/branded.ts";
import type { MarimoApiCall } from "../../../types.ts";
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
      marimoVersion: "1.2.3",
    },
  ],
} as const;

function makeLayer(recorded: MarimoApiCall[], snapshot: unknown = SNAPSHOT) {
  return LiveSessions.layer.pipe(
    Layer.provide(
      makeTestMarimoClient({
        execute: (request) =>
          Effect.sync(() => {
            recorded.push(request);
            return request.method === "list-sessions" ? snapshot : null;
          }),
      }),
    ),
  );
}

it.effect(
  "decodes the authoritative session snapshot",
  Effect.fn(function* () {
    const recorded: MarimoApiCall[] = [];

    const live = yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      return yield* sessions.get;
    }).pipe(Effect.provide(makeLayer(recorded)));

    expect(live).toEqual(SNAPSHOT.sessions);
    expect(recorded).toEqual([{ method: "list-sessions", params: {} }]);
  }),
);

it.effect(
  "decodes an older session snapshot with an unknown marimo version",
  Effect.fn(function* () {
    const recorded: MarimoApiCall[] = [];
    const legacy = {
      sessions: SNAPSHOT.sessions.map(
        ({ marimoVersion: _, ...session }) => session,
      ),
    };

    const live = yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      return yield* sessions.get;
    }).pipe(Effect.provide(makeLayer(recorded, legacy)));

    expect(live[0]?.marimoVersion).toBeNull();
  }),
);

it.effect(
  "shuts down every session and reconciles once",
  Effect.fn(function* () {
    const recorded: MarimoApiCall[] = [];
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
      { method: "list-sessions", params: {} },
      { method: "shutdown-all-sessions", params: {} },
      { method: "list-sessions", params: {} },
    ]);
  }),
);

it.effect(
  "fails when a session disappears before restart",
  Effect.fn(function* () {
    const recorded: MarimoApiCall[] = [];
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
    expect(recorded).toEqual([{ method: "list-sessions", params: {} }]);
  }),
);

it.effect(
  "restarts a session and reconciles with the server snapshot",
  Effect.fn(function* () {
    const recorded: MarimoApiCall[] = [];

    yield* Effect.gen(function* () {
      const sessions = yield* LiveSessions;
      yield* sessions.restart(NOTEBOOK_URI);
    }).pipe(Effect.provide(makeLayer(recorded)));

    expect(recorded).toEqual([
      { method: "list-sessions", params: {} },
      {
        method: "restart-session",
        params: {
          notebookUri: NOTEBOOK_URI,
          inner: {
            executable: "/venv/bin/python",
            workingDirectory: "/workspace",
          },
        },
      },
      { method: "list-sessions", params: {} },
    ]);
  }),
);
