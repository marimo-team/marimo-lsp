import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { makeTestMarimoClient } from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { notebookId } from "../../../lib/__tests__/branded.ts";
import type { MarimoApiCall } from "../../../types.ts";
import { SessionsService } from "../SessionsService.ts";

const NOTEBOOK_URI = notebookId("file:///workspace/notebook.py");
const SNAPSHOT = {
  sessions: [
    {
      sessionId: "session-1",
      notebookUri: NOTEBOOK_URI,
      filename: "notebook.py",
      executable: "/venv/bin/python",
      startedAt: 42,
      status: "idle",
      attached: false,
    },
  ],
} as const;

function makeLayer(recorded: MarimoApiCall[]) {
  return SessionsService.Default.pipe(
    Layer.provide(
      makeTestMarimoClient({
        execute: (request) =>
          Effect.sync(() => {
            recorded.push(request);
            return request.method === "list-sessions" ? SNAPSHOT : null;
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
      const sessions = yield* SessionsService;
      yield* sessions.refresh();
      return yield* sessions.get();
    }).pipe(Effect.provide(makeLayer(recorded)));

    expect(live).toEqual(SNAPSHOT.sessions);
    expect(recorded).toEqual([{ method: "list-sessions", params: {} }]);
  }),
);

it.effect(
  "restarts a session and reconciles with the server snapshot",
  Effect.fn(function* () {
    const recorded: MarimoApiCall[] = [];

    yield* Effect.gen(function* () {
      const sessions = yield* SessionsService;
      yield* sessions.refresh();
      yield* sessions.restart(NOTEBOOK_URI);
    }).pipe(Effect.provide(makeLayer(recorded)));

    expect(recorded).toEqual([
      { method: "list-sessions", params: {} },
      {
        method: "restart-session",
        params: { notebookUri: NOTEBOOK_URI, inner: {} },
      },
      { method: "list-sessions", params: {} },
    ]);
  }),
);
