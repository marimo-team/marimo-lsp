import * as Vitest from "@effect/vitest";
import {
  Context,
  Effect,
  Fiber,
  Latch,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";

import * as MarimoClientTest from "../../__tests__/fake/MarimoClient.ts";
import * as NotebookRuntimeTest from "../../__tests__/fake/NotebookRuntime.ts";
import * as VsCodeTest from "../../__tests__/fake/VsCode.ts";
import * as EffectTest from "../../__tests__/lib/EffectTest.ts";
import type * as NotebookRuntime from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { DependencyTreeNode } from "../../schemas/Models.gen.ts";
import * as NotebookDependencies from "../NotebookDependencies.ts";
import * as NotebookDocumentSessions from "../NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../NotebookSessionResources.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const OTHER_NOTEBOOK_URI = notebookId("file:///test/other.py");

const TREE: DependencyTreeNode = {
  name: "<root>",
  version: null,
  tags: [],
  dependencies: [],
};

/** Latches a scripted server response can hold until the test releases it. */
class Gate extends Context.Service<
  Gate,
  {
    readonly requestStarted: Latch.Latch;
    readonly releaseRequest: Latch.Latch;
  }
>()("@marimo/test/NotebookDependencies/Gate") {}

type Responder = (
  request: MarimoClientTest.Command,
  context: {
    readonly gate: Gate["Service"];
    readonly commands: ReadonlyArray<MarimoClientTest.Command>;
  },
) => Effect.Effect<unknown, Schema.SchemaError>;

interface Options {
  readonly notebooks?: ReadonlyArray<NotebookId>;
  readonly controllers?: ReadonlyArray<NotebookRuntime.NotebookControllerSelection>;
  readonly respond?: Responder;
}

function makeController(options: {
  readonly id: string;
  readonly executable?: string;
}): NotebookRuntime.NotebookController {
  return {
    ...options,
    drive: () => () => Effect.void,
    presentOutputs: () => Effect.void,
    resolveExecutable: () =>
      Effect.succeed(options.executable ?? "/unused/python"),
  };
}

const scriptController = {
  notebookUri: NOTEBOOK_URI,
  controller: makeController({ id: "script" }),
};

const layerWith = (options: Options = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const gate = {
        requestStarted: yield* Latch.make(),
        releaseRequest: yield* Latch.make(),
      };
      const respond = options.respond ?? (() => Effect.succeed({ tree: TREE }));
      const documents = (options.notebooks ?? [NOTEBOOK_URI]).map((uri) =>
        VsCodeTest.createTestNotebookDocument(VsCodeTest.Uri.parse(uri)),
      );
      const runtimeLayer = NotebookRuntimeTest.layerWith({
        initialControllers: options.controllers ?? [scriptController],
        send: (request, commands) => respond(request, { gate, commands }),
      });
      return Layer.merge(
        NotebookSessionResources.layer.pipe(
          Layer.provideMerge(runtimeLayer),
          Layer.provideMerge(NotebookDocumentSessions.layer),
          Layer.provideMerge(
            VsCodeTest.layerWith({ initialDocuments: documents }),
          ),
        ),
        Layer.succeed(Gate, gate),
      );
    }),
  );

/** Signals that the request started, then waits for the test to release it. */
const holdOpen = (gate: Gate["Service"], response: unknown) =>
  gate.requestStarted.open.pipe(
    Effect.andThen(gate.releaseRequest.await),
    Effect.as(response),
  );

const isTerminal = (state: NotebookDependencies.State) =>
  state._tag === "Loaded" || state._tag === "Failed";

/** Runs the effect inside the notebook's session resources. */
const inNotebook = <A, E, R>(id: NotebookId, effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const sessions = yield* NotebookDocumentSessions.Service;
    const resources = yield* NotebookSessionResources.Service;
    const session = sessions.current(id);
    if (Option.isNone(session)) {
      return yield* Effect.die(`Expected an open session for ${id}`);
    }
    return yield* resources
      .runScoped(session.value, effect)
      .pipe(Scope.provide(session.value.scope), Effect.orDie);
  });

/** Collects dependency states until the first terminal one. */
const collect = (
  options: {
    readonly notebookId?: NotebookId;
    readonly onState?: Effect.Effect<unknown>;
  } = {},
) =>
  inNotebook(
    options.notebookId ?? NOTEBOOK_URI,
    Effect.flatMap(NotebookDependencies.Service, (service) =>
      service.changes.pipe(
        Stream.tap(() => options.onState ?? Effect.void),
        Stream.takeUntil(isTerminal),
        Stream.runCollect,
      ),
    ),
  ).pipe(Effect.map((states) => Array.from(states)));

const current = (id: NotebookId = NOTEBOOK_URI) =>
  inNotebook(
    id,
    Effect.flatMap(NotebookDependencies.Service, (service) =>
      service.changes.pipe(Stream.take(1), Stream.runHead),
    ),
  ).pipe(Effect.map(Option.getOrThrow));

const refresh = (id: NotebookId = NOTEBOOK_URI) =>
  inNotebook(
    id,
    Effect.flatMap(NotebookDependencies.Service, (service) => service.refresh),
  );

const requests = Effect.gen(function* () {
  const marimo = yield* MarimoClientTest.Service;
  return yield* marimo.commands;
});

const requestKinds = Effect.map(requests, (commands) =>
  commands.map((request) => request.kind),
);

const invalid = Schema.decodeUnknownEffect(Schema.Number)("invalid");

Vitest.describe("NotebookDependencies", () => {
  const it = EffectTest.make(
    layerWith({
      notebooks: [NOTEBOOK_URI, OTHER_NOTEBOOK_URI],
      controllers: [
        scriptController,
        {
          notebookUri: OTHER_NOTEBOOK_URI,
          controller: makeController({
            id: "python",
            executable: "/other/.venv/bin/python",
          }),
        },
      ],
    }),
  );

  it.effect(
    "loads through the controller owned by its notebook session",
    Effect.fn(function* () {
      const states = yield* collect({ notebookId: OTHER_NOTEBOOK_URI });

      Vitest.expect(states.at(-1)).toEqual({ _tag: "Loaded", tree: TREE });
      Vitest.expect(yield* requests).toEqual([
        {
          kind: "get-dependency-tree",
          notebookUri: OTHER_NOTEBOOK_URI,
          source: {
            kind: "venv",
            executable: "/other/.venv/bin/python",
          },
        },
      ]);
    }),
  );

  Vitest.describe("with a shared load", () => {
    const it = EffectTest.make(
      layerWith({
        respond: (_request, { gate }) => holdOpen(gate, { tree: TREE }),
      }),
    );

    it.effect(
      "shares one in-flight load between changes subscribers",
      Effect.fn(function* () {
        const gate = yield* Gate;
        const firstSubscribed = yield* Latch.make();
        const secondSubscribed = yield* Latch.make();
        const subscribers = yield* Effect.all(
          [
            collect({ onState: firstSubscribed.open }),
            collect({ onState: secondSubscribed.open }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* firstSubscribed.await;
        yield* secondSubscribed.await;
        yield* gate.requestStarted.await;

        Vitest.expect(yield* requests).toHaveLength(1);
        yield* gate.releaseRequest.open;
        const results = yield* Fiber.join(subscribers);
        Vitest.expect(results[0]?.at(-1)).toEqual({
          _tag: "Loaded",
          tree: TREE,
        });
        Vitest.expect(results[1]?.at(-1)).toEqual({
          _tag: "Loaded",
          tree: TREE,
        });
      }),
    );
  });

  Vitest.describe("with a Python environment", () => {
    const it = EffectTest.make(
      layerWith({
        controllers: [
          {
            notebookUri: NOTEBOOK_URI,
            controller: makeController({
              id: "python",
              executable: "/test/.venv/bin/python",
            }),
          },
        ],
        respond: (request) =>
          request.kind === "get-dependency-tree"
            ? invalid
            : Effect.succeed({
                packages: [{ name: "effect", version: "4.0.0" }],
              }),
      }),
    );

    it.effect(
      "falls back to the flat package list for a Python environment",
      Effect.fn(function* () {
        const states = yield* collect();

        Vitest.expect(states.at(-1)).toEqual({
          _tag: "Loaded",
          tree: {
            name: "installed-packages",
            version: null,
            tags: [],
            dependencies: [
              {
                name: "effect",
                version: "4.0.0",
                tags: [],
                dependencies: [],
              },
            ],
          },
        });
        Vitest.expect(yield* requestKinds).toEqual([
          "get-dependency-tree",
          "list-packages",
        ]);
      }),
    );
  });

  Vitest.describe("with a script failure", () => {
    const it = EffectTest.make(layerWith({ respond: () => invalid }));

    it.effect(
      "preserves script-mode failures without using the venv fallback",
      Effect.fn(function* () {
        const expectedError = String(yield* Effect.flip(invalid));
        const states = yield* collect();

        Vitest.expect(states.at(-1)).toEqual({
          _tag: "Failed",
          error: expectedError,
        });
        Vitest.expect(yield* requestKinds).toEqual(["get-dependency-tree"]);
      }),
    );
  });

  Vitest.describe("without a controller", () => {
    const it = EffectTest.make(
      layerWith({
        controllers: [],
        respond: (request) => Effect.die(`Unexpected command: ${request.kind}`),
      }),
    );

    it.effect(
      "reports a missing controller without calling the server",
      Effect.fn(function* () {
        const states = yield* collect();

        Vitest.expect(states.at(-1)).toEqual({
          _tag: "Failed",
          error: "No kernel selected",
        });
        Vitest.expect(yield* requests).toEqual([]);
      }),
    );
  });

  Vitest.describe("with a cached load", () => {
    const it = EffectTest.make(
      layerWith({
        respond: (request, { commands }) =>
          request.kind !== "get-dependency-tree"
            ? Effect.die(`Unexpected command: ${request.kind}`)
            : Effect.succeed({
                tree: {
                  ...TREE,
                  name: commands.length === 1 ? "first" : "refreshed",
                },
              }),
      }),
    );

    it.effect(
      "refreshes a successfully cached dependency tree",
      Effect.fn(function* () {
        const initial = yield* collect();
        Vitest.expect(initial.at(-1)).toEqual({
          _tag: "Loaded",
          tree: { ...TREE, name: "first" },
        });

        Vitest.expect(yield* current()).toEqual({
          _tag: "Loaded",
          tree: { ...TREE, name: "first" },
        });

        yield* refresh();
        Vitest.expect(yield* current()).toEqual({
          _tag: "Loaded",
          tree: { ...TREE, name: "refreshed" },
        });
        Vitest.expect(yield* requests).toHaveLength(2);
      }),
    );
  });

  Vitest.describe("while a refresh is in flight", () => {
    const it = EffectTest.make(
      layerWith({
        respond: (request, { gate, commands }) =>
          request.kind !== "get-dependency-tree"
            ? Effect.die(`Unexpected command: ${request.kind}`)
            : commands.length === 1
              ? holdOpen(gate, { tree: { ...TREE, name: "older" } })
              : Effect.succeed({ tree: { ...TREE, name: "newer" } }),
      }),
    );

    it.effect(
      "does not publish a load invalidated by refresh",
      Effect.fn(function* () {
        const gate = yield* Gate;
        const staleRefresh = yield* refresh().pipe(Effect.forkChild);
        yield* gate.requestStarted.await;

        yield* refresh();
        yield* gate.releaseRequest.open;
        yield* Fiber.join(staleRefresh);

        Vitest.expect(yield* current()).toEqual({
          _tag: "Loaded",
          tree: { ...TREE, name: "newer" },
        });
      }),
    );
  });
});
