import {
  Context,
  Data,
  Effect,
  Latch,
  Layer,
  PubSub,
  Ref,
  Stream,
} from "effect";

import {
  makeTestMarimoClient,
  type TestCommand,
} from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { kernelSessionId, notebookId } from "../../../lib/__tests__/branded.ts";
import type { ListSessionsResponse } from "../../../schemas/Models.gen.ts";
import * as LiveSessions from "../LiveSessions.ts";

export const NOTEBOOK_URI = notebookId("file:///workspace/notebook.py");
export const SNAPSHOT = {
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

export const REPLACEMENT = {
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

export type Scenario = Data.TaggedEnum<{
  Snapshot: {};
  LateQuery: {};
  Restart: {};
  InterruptedRestart: {};
  Shutdown: {};
  MissingSession: {};
}>;
export const Scenario = Data.taggedEnum<Scenario>();

export interface Interface {
  readonly requests: Effect.Effect<ReadonlyArray<TestCommand>>;
  readonly requestStarted: Effect.Effect<void>;
  readonly releaseRequest: Effect.Effect<void>;
  readonly publish: (snapshot: ListSessionsResponse) => Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/LiveSessions",
) {}

export const layerWith = (scenario: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
      const changes = yield* PubSub.unbounded<ListSessionsResponse>();
      const requestStarted = yield* Latch.make();
      const releaseRequest = yield* Latch.make();
      let queries = 0;

      const send = (request: TestCommand): Effect.Effect<unknown> => {
        if (Scenario.$is("LateQuery")(scenario)) {
          return request.kind === "list-sessions" && ++queries > 1
            ? requestStarted.open.pipe(
                Effect.andThen(releaseRequest.await),
                Effect.as(SNAPSHOT),
              )
            : Effect.succeed(SNAPSHOT);
        }
        if (Scenario.$is("Restart")(scenario)) {
          return request.kind === "restart-session"
            ? requestStarted.open.pipe(
                Effect.andThen(releaseRequest.await),
                Effect.as({ ...SNAPSHOT, revision: 2 }),
              )
            : Effect.succeed(SNAPSHOT);
        }
        if (Scenario.$is("InterruptedRestart")(scenario)) {
          return request.kind === "restart-session"
            ? requestStarted.open.pipe(Effect.andThen(Effect.never))
            : Effect.succeed(SNAPSHOT);
        }
        if (Scenario.$is("Shutdown")(scenario)) {
          if (request.kind === "list-sessions") {
            return Effect.succeed(queries++ === 0 ? SNAPSHOT : null);
          }
          return Effect.succeed({ ...SNAPSHOT, revision: 2, sessions: [] });
        }
        if (Scenario.$is("MissingSession")(scenario)) {
          return Effect.succeed({ ...SNAPSHOT, sessions: [] });
        }
        return Effect.succeed(SNAPSHOT);
      };

      const clientLayer = makeTestMarimoClient({
        sessionChanges: Stream.fromPubSub(changes),
        send: (request) =>
          Ref.update(requests, (current) => [...current, request]).pipe(
            Effect.andThen(send(request)),
          ),
      });
      const environment = LiveSessions.layer.pipe(Layer.provide(clientLayer));
      const fixture = Layer.succeed(Service, {
        requests: Ref.get(requests),
        requestStarted: requestStarted.await,
        releaseRequest: releaseRequest.open.pipe(Effect.asVoid),
        publish: (snapshot) =>
          PubSub.publish(changes, snapshot).pipe(Effect.asVoid),
      });

      return Layer.merge(environment, fixture);
    }),
  );

export const layer = layerWith(Scenario.Snapshot());
