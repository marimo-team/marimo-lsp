import * as Vitest from "@effect/vitest";
import {
  Context,
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  Result,
  Stream,
} from "effect";

import * as LiveSessions from "../../../src/panel/sessions/LiveSessions.ts";
import type { ListSessionsResponse } from "../../../src/schemas/Models.gen.ts";
import * as MarimoClientTest from "../../fake/MarimoClient.ts";
import { kernelSessionId, notebookId } from "../../lib/branded.ts";
import * as EffectTest from "../../lib/EffectTest.ts";

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
} as const satisfies ListSessionsResponse;

const REPLACEMENT = {
  ...SNAPSHOT,
  revision: 3,
  sessions: [
    {
      ...SNAPSHOT.sessions[0],
      sessionId: kernelSessionId("00000000-0000-4000-8000-000000000002"),
      status: "running" as const,
    },
  ],
} satisfies ListSessionsResponse;

/** Latches a scripted server response can hold until the test releases it. */
class Gate extends Context.Service<
  Gate,
  {
    readonly requestStarted: Latch.Latch;
    readonly releaseRequest: Latch.Latch;
  }
>()("@marimo/test/LiveSessions/Gate") {}

/** Answers one server command given this test's gate and the commands so far. */
type Responder = (
  request: MarimoClientTest.Command,
  context: {
    readonly gate: Gate["Service"];
    readonly commands: ReadonlyArray<MarimoClientTest.Command>;
  },
) => Effect.Effect<unknown>;

/** Runs LiveSessions against a marimo server that answers with `respond`. */
const layerWith = (respond: Responder) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const gate = {
        requestStarted: yield* Latch.make(),
        releaseRequest: yield* Latch.make(),
      };
      return Layer.merge(
        LiveSessions.layer.pipe(
          Layer.provideMerge(
            MarimoClientTest.layerWith({
              send: (request, commands) => respond(request, { gate, commands }),
            }),
          ),
        ),
        Layer.succeed(Gate, gate),
      );
    }),
  );

const count = (
  commands: ReadonlyArray<MarimoClientTest.Command>,
  kind: MarimoClientTest.Command["kind"],
) => commands.filter((command) => command.kind === kind).length;

/** Signals that the request started, then waits for the test to release it. */
const holdOpen = (gate: Gate["Service"], response: unknown) =>
  gate.requestStarted.open.pipe(
    Effect.andThen(gate.releaseRequest.await),
    Effect.as(response),
  );

Vitest.describe("LiveSessions", () => {
  const it = EffectTest.make(layerWith(() => Effect.succeed(SNAPSHOT)));

  it.effect.each([
    { generation: 1, revision: 100 },
    { generation: 2, revision: 0 },
    { generation: 2, revision: 1 },
  ])(
    "ignores older or duplicate state after a server restart (%j)",
    (version) =>
      Effect.gen(function* () {
        const live = yield* LiveSessions.Service;
        yield* live.accept({ ...SNAPSHOT, revision: 50 });
        yield* live.accept({ generation: 2, revision: 1, sessions: [] });
        yield* live.accept({ ...SNAPSHOT, ...version });

        Vitest.expect(yield* live.get).toEqual([]);
      }),
  );

  Vitest.describe("when an earlier query returns late", () => {
    const it = EffectTest.make(
      layerWith((request, { gate, commands }) =>
        request.kind === "list-sessions" && count(commands, "list-sessions") > 1
          ? holdOpen(gate, SNAPSHOT)
          : Effect.succeed(SNAPSHOT),
      ),
    );

    it.effect(
      "does not resurrect a closed session when an earlier query returns late",
      Effect.fn(function* () {
        const gate = yield* Gate;
        const marimo = yield* MarimoClientTest.Service;
        const live = yield* LiveSessions.Service;
        const refresh = yield* live.refresh.pipe(Effect.forkChild);
        yield* gate.requestStarted.await;
        const closed = yield* live.changes.pipe(
          Stream.filter((items) => items.length === 0),
          Stream.runHead,
          Effect.forkChild,
        );
        yield* marimo.publishSessionsChanged({
          ...SNAPSHOT,
          revision: 2,
          sessions: [],
        });
        yield* Fiber.join(closed);
        yield* gate.releaseRequest.open;

        Vitest.expect(yield* Fiber.join(refresh)).toEqual([]);
        Vitest.expect(yield* live.get).toEqual([]);
      }),
    );
  });

  Vitest.describe("while restarting", () => {
    const it = EffectTest.make(
      layerWith((request, { gate }) =>
        request.kind === "restart-session"
          ? holdOpen(gate, { ...SNAPSHOT, revision: 2 })
          : Effect.succeed(SNAPSHOT),
      ),
    );

    it.effect(
      "keeps restarting as a view overlay and shows the latest status when restart finishes",
      Effect.fn(function* () {
        const gate = yield* Gate;
        const live = yield* LiveSessions.Service;
        const restart = yield* live
          .restart(NOTEBOOK_URI)
          .pipe(Effect.forkChild);
        yield* gate.requestStarted.await;
        yield* live.accept(REPLACEMENT);

        Vitest.expect(
          Option.getOrThrow(yield* live.find(NOTEBOOK_URI)),
        ).toMatchObject({
          sessionId: REPLACEMENT.sessions[0]?.sessionId,
          status: "restarting",
        });
        yield* gate.releaseRequest.open;
        yield* Fiber.join(restart);
        Vitest.expect(yield* live.get).toEqual(REPLACEMENT.sessions);
      }),
    );
  });

  Vitest.describe("when restart is interrupted", () => {
    const it = EffectTest.make(
      layerWith((request, { gate }) =>
        request.kind === "restart-session"
          ? gate.requestStarted.open.pipe(Effect.andThen(Effect.never))
          : Effect.succeed(SNAPSHOT),
      ),
    );

    it.effect(
      "does not restore a dead session when restart is interrupted",
      Effect.fn(function* () {
        const gate = yield* Gate;
        const live = yield* LiveSessions.Service;
        const restart = yield* live
          .restart(NOTEBOOK_URI)
          .pipe(Effect.forkChild);
        yield* gate.requestStarted.await;
        yield* live.accept({ ...SNAPSHOT, revision: 2, sessions: [] });
        yield* Fiber.interrupt(restart);

        Vitest.expect(yield* live.get).toEqual([]);
      }),
    );
  });

  Vitest.describe("when shutting down", () => {
    const it = EffectTest.make(
      layerWith((request, { commands }) =>
        request.kind === "list-sessions"
          ? Effect.succeed(
              count(commands, "list-sessions") === 1 ? SNAPSHOT : null,
            )
          : Effect.succeed({ ...SNAPSHOT, revision: 2, sessions: [] }),
      ),
    );

    it.effect.each(["shutdown", "shutdownAll"] as const)(
      "%s applies its response without a follow-up query",
      (method) =>
        Effect.gen(function* () {
          const marimo = yield* MarimoClientTest.Service;
          const live = yield* LiveSessions.Service;
          yield* method === "shutdown"
            ? live.shutdown(NOTEBOOK_URI)
            : live.shutdownAll;

          Vitest.expect(yield* live.get).toEqual([]);
          Vitest.expect(
            (yield* marimo.commands).map((request) => request.kind),
          ).toEqual([
            "list-sessions",
            method === "shutdown" ? "close-session" : "shutdown-all-sessions",
          ]);
        }),
    );
  });

  Vitest.describe("without a live session", () => {
    const it = EffectTest.make(
      layerWith(() => Effect.succeed({ ...SNAPSHOT, sessions: [] })),
    );

    it.effect(
      "fails when a session disappears before restart",
      Effect.fn(function* () {
        const live = yield* LiveSessions.Service;
        const result = yield* Effect.result(live.restart(NOTEBOOK_URI));

        Vitest.expect(Result.isFailure(result)).toBe(true);
        if (Result.isFailure(result)) {
          Vitest.expect(result.failure).toEqual(
            new LiveSessions.NotFoundError({ notebookUri: NOTEBOOK_URI }),
          );
        }
      }),
    );
  });
});
