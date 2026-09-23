import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Option, Result, Stream } from "effect";

import * as EffectTest from "../../../__tests__/__utils__/EffectTest.ts";
import * as LiveSessions from "../LiveSessions.ts";
import * as TestLiveSessions from "./TestLiveSessions.ts";

Vitest.describe("LiveSessions", () => {
  const it = EffectTest.make(TestLiveSessions.layer);

  it.effect.each([
    { generation: 1, revision: 100 },
    { generation: 2, revision: 0 },
    { generation: 2, revision: 1 },
  ])(
    "ignores older or duplicate state after a server restart (%j)",
    (version) =>
      Effect.gen(function* () {
        const live = yield* LiveSessions.Service;
        yield* live.accept({ ...TestLiveSessions.SNAPSHOT, revision: 50 });
        yield* live.accept({ generation: 2, revision: 1, sessions: [] });
        yield* live.accept({ ...TestLiveSessions.SNAPSHOT, ...version });

        Vitest.expect(yield* live.get).toEqual([]);
      }),
  );

  Vitest.describe("when an earlier query returns late", () => {
    const it = EffectTest.make(
      TestLiveSessions.layerWith(TestLiveSessions.Scenario.LateQuery()),
    );

    it.effect(
      "does not resurrect a closed session when an earlier query returns late",
      Effect.fn(function* () {
        const fixture = yield* TestLiveSessions.Service;
        const live = yield* LiveSessions.Service;
        const refresh = yield* live.refresh.pipe(Effect.forkChild);
        yield* fixture.requestStarted;
        const closed = yield* live.changes.pipe(
          Stream.filter((items) => items.length === 0),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* fixture.publish({
          ...TestLiveSessions.SNAPSHOT,
          revision: 2,
          sessions: [],
        });
        yield* Fiber.join(closed);
        yield* fixture.releaseRequest;

        Vitest.expect(yield* Fiber.join(refresh)).toEqual([]);
        Vitest.expect(yield* live.get).toEqual([]);
      }),
    );
  });

  Vitest.describe("while restarting", () => {
    const it = EffectTest.make(
      TestLiveSessions.layerWith(TestLiveSessions.Scenario.Restart()),
    );

    it.effect(
      "keeps restarting as a view overlay and shows the latest status when restart finishes",
      Effect.fn(function* () {
        const fixture = yield* TestLiveSessions.Service;
        const live = yield* LiveSessions.Service;
        const restart = yield* live
          .restart(TestLiveSessions.NOTEBOOK_URI)
          .pipe(Effect.forkChild);
        yield* fixture.requestStarted;
        yield* live.accept(TestLiveSessions.REPLACEMENT);

        Vitest.expect(
          Option.getOrThrow(yield* live.find(TestLiveSessions.NOTEBOOK_URI)),
        ).toMatchObject({
          sessionId: TestLiveSessions.REPLACEMENT.sessions[0]?.sessionId,
          status: "restarting",
        });
        yield* fixture.releaseRequest;
        yield* Fiber.join(restart);
        Vitest.expect(yield* live.get).toEqual(
          TestLiveSessions.REPLACEMENT.sessions,
        );
      }),
    );
  });

  Vitest.describe("when restart is interrupted", () => {
    const it = EffectTest.make(
      TestLiveSessions.layerWith(
        TestLiveSessions.Scenario.InterruptedRestart(),
      ),
    );

    it.effect(
      "does not restore a dead session when restart is interrupted",
      Effect.fn(function* () {
        const fixture = yield* TestLiveSessions.Service;
        const live = yield* LiveSessions.Service;
        const restart = yield* live
          .restart(TestLiveSessions.NOTEBOOK_URI)
          .pipe(Effect.forkChild);
        yield* fixture.requestStarted;
        yield* live.accept({
          ...TestLiveSessions.SNAPSHOT,
          revision: 2,
          sessions: [],
        });
        yield* Fiber.interrupt(restart);

        Vitest.expect(yield* live.get).toEqual([]);
      }),
    );
  });

  Vitest.describe("when shutting down", () => {
    const it = EffectTest.make(
      TestLiveSessions.layerWith(TestLiveSessions.Scenario.Shutdown()),
    );

    it.effect.each(["shutdown", "shutdownAll"] as const)(
      "%s applies its response without a follow-up query",
      (method) =>
        Effect.gen(function* () {
          const fixture = yield* TestLiveSessions.Service;
          const live = yield* LiveSessions.Service;
          yield* method === "shutdown"
            ? live.shutdown(TestLiveSessions.NOTEBOOK_URI)
            : live.shutdownAll;

          Vitest.expect(yield* live.get).toEqual([]);
          Vitest.expect(
            (yield* fixture.requests).map((request) => request.kind),
          ).toEqual([
            "list-sessions",
            method === "shutdown" ? "close-session" : "shutdown-all-sessions",
          ]);
        }),
    );
  });

  Vitest.describe("without a live session", () => {
    const it = EffectTest.make(
      TestLiveSessions.layerWith(TestLiveSessions.Scenario.MissingSession()),
    );

    it.effect(
      "fails when a session disappears before restart",
      Effect.fn(function* () {
        const live = yield* LiveSessions.Service;
        const result = yield* Effect.result(
          live.restart(TestLiveSessions.NOTEBOOK_URI),
        );

        Vitest.expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          Vitest.expect(result.failure).toEqual(
            new LiveSessions.NotFoundError({
              notebookUri: TestLiveSessions.NOTEBOOK_URI,
            }),
          );
        }
      }),
    );
  });
});
