import { assert, describe, expect, it } from "@effect/vitest";
import {
  Deferred,
  Effect,
  Fiber,
  Layer,
  Option,
  Schema,
  Scope,
  Stream,
} from "effect";

import {
  createTestNotebookDocument,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import type {
  NotebookController,
  NotebookControllerSelection,
} from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { DependencyTreeNode } from "../../schemas/Models.gen.ts";
import type { MarimoApiCall } from "../../types.ts";
import {
  NotebookDependencies,
  type NotebookDependencyState,
} from "../NotebookDependencies.ts";
import { NotebookDocumentSessions } from "../NotebookDocumentSessions.ts";
import { NotebookSessionResources } from "../NotebookSessionResources.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const OTHER_NOTEBOOK_URI = notebookId("file:///test/other.py");

const TREE: DependencyTreeNode = {
  name: "<root>",
  version: null,
  tags: [],
  dependencies: [],
};

function makeController(options: {
  readonly id: string;
  readonly executable?: string;
}): NotebookController {
  return {
    ...options,
    drive: () => () => Effect.void,
    resolveExecutable: () =>
      Effect.succeed(options.executable ?? "/unused/python"),
  };
}

const isTerminal = (state: NotebookDependencyState) =>
  state._tag === "Loaded" || state._tag === "Failed";

const makeContext = Effect.fn(function* (options: {
  readonly notebookIds?: ReadonlyArray<NotebookId>;
  readonly controllers?: ReadonlyArray<NotebookControllerSelection>;
  readonly execute: (
    request: MarimoApiCall,
  ) => Effect.Effect<unknown, Schema.SchemaError>;
}) {
  const notebookIds = options.notebookIds ?? [NOTEBOOK_URI];
  const documents = notebookIds.map((uri) =>
    createTestNotebookDocument(Uri.parse(uri)),
  );
  const vscode = yield* TestVsCode.make({ initialDocuments: documents });
  const requests: MarimoApiCall[] = [];
  const runtime = makeTestNotebookRuntime({
    initialControllers: options.controllers,
    execute: (request) =>
      Effect.sync(() => requests.push(request)).pipe(
        Effect.andThen(options.execute(request)),
      ),
  });
  const sessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(vscode.layer),
  );
  const resources = NotebookSessionResources.layer.pipe(
    Layer.provide(sessions),
    Layer.provide(runtime),
  );

  return {
    requests,
    layer: Layer.mergeAll(vscode.layer, sessions, resources),
  };
});

const inNotebook = <A, E, R>(
  notebookUri: NotebookId,
  effect: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const sessions = yield* NotebookDocumentSessions;
    const resources = yield* NotebookSessionResources;
    const session = sessions.current(notebookUri);
    assert(session !== undefined);
    return yield* resources
      .runScoped(session, effect)
      .pipe(Scope.provide(session.scope));
  });

const collectUntilTerminal = (notebookUri: NotebookId) =>
  inNotebook(
    notebookUri,
    NotebookDependencies.pipe(
      Effect.flatMap((dependencies) =>
        dependencies.changes.pipe(
          Stream.takeUntil(isTerminal),
          Stream.runCollect,
        ),
      ),
    ),
  );

describe("NotebookDependencies", () => {
  it.effect("loads through the controller owned by its notebook session", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext({
        notebookIds: [NOTEBOOK_URI, OTHER_NOTEBOOK_URI],
        controllers: [
          {
            notebookUri: NOTEBOOK_URI,
            controller: makeController({ id: "script" }),
          },
          {
            notebookUri: OTHER_NOTEBOOK_URI,
            controller: makeController({
              id: "python",
              executable: "/other/.venv/bin/python",
            }),
          },
        ],
        execute: () => Effect.succeed({ tree: TREE }),
      });

      const states = yield* collectUntilTerminal(OTHER_NOTEBOOK_URI).pipe(
        Effect.provide(ctx.layer),
      );

      expect(states.at(-1)).toEqual({ _tag: "Loaded", tree: TREE });
      expect(ctx.requests).toEqual([
        {
          method: "get-dependency-tree",
          params: {
            notebookUri: OTHER_NOTEBOOK_URI,
            source: {
              kind: "venv",
              executable: "/other/.venv/bin/python",
            },
            inner: {},
          },
        },
      ]);
    }),
  );

  it.effect("shares one in-flight load between changes subscribers", () =>
    Effect.gen(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const firstSubscribed = yield* Deferred.make<void>();
      const secondSubscribed = yield* Deferred.make<void>();
      const controller = makeController({ id: "script" });
      const ctx = yield* makeContext({
        controllers: [{ notebookUri: NOTEBOOK_URI, controller }],
        execute: () =>
          Deferred.succeed(requestStarted, undefined).pipe(
            Effect.andThen(Deferred.await(releaseRequest)),
            Effect.as({ tree: TREE }),
          ),
      });

      const collect = (subscribed: Deferred.Deferred<void>) =>
        inNotebook(
          NOTEBOOK_URI,
          NotebookDependencies.pipe(
            Effect.flatMap((dependencies) =>
              dependencies.changes.pipe(
                Stream.tap(() => Deferred.succeed(subscribed, undefined)),
                Stream.takeUntil(isTerminal),
                Stream.runCollect,
              ),
            ),
          ),
        );

      yield* Effect.gen(function* () {
        const subscribers = yield* Effect.all(
          [collect(firstSubscribed), collect(secondSubscribed)],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* Deferred.await(firstSubscribed);
        yield* Deferred.await(secondSubscribed);
        yield* Deferred.await(requestStarted);

        expect(ctx.requests).toHaveLength(1);
        yield* Deferred.succeed(releaseRequest, undefined);
        const results = yield* Fiber.join(subscribers);
        expect(results[0].at(-1)).toEqual({ _tag: "Loaded", tree: TREE });
        expect(results[1].at(-1)).toEqual({ _tag: "Loaded", tree: TREE });
      }).pipe(Effect.provide(ctx.layer));
    }),
  );

  it.effect(
    "falls back to the flat package list for a Python environment",
    () =>
      Effect.gen(function* () {
        const treeFailure = Schema.decodeUnknownEffect(Schema.Number)(
          "invalid",
        );
        const controller = makeController({
          id: "python",
          executable: "/test/.venv/bin/python",
        });
        const ctx = yield* makeContext({
          controllers: [{ notebookUri: NOTEBOOK_URI, controller }],
          execute: (request) =>
            request.method === "get-dependency-tree"
              ? treeFailure
              : Effect.succeed({
                  packages: [{ name: "effect", version: "4.0.0" }],
                }),
        });

        const states = yield* collectUntilTerminal(NOTEBOOK_URI).pipe(
          Effect.provide(ctx.layer),
        );

        expect(states.at(-1)).toEqual({
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
        expect(ctx.requests.map((request) => request.method)).toEqual([
          "get-dependency-tree",
          "get-package-list",
        ]);
      }),
  );

  it.effect(
    "preserves script-mode failures without using the venv fallback",
    () =>
      Effect.gen(function* () {
        const failure = Schema.decodeUnknownEffect(Schema.Number)("invalid");
        const expectedError = String(yield* Effect.flip(failure));
        const controller = makeController({ id: "script" });
        const ctx = yield* makeContext({
          controllers: [{ notebookUri: NOTEBOOK_URI, controller }],
          execute: () => failure,
        });

        const states = yield* collectUntilTerminal(NOTEBOOK_URI).pipe(
          Effect.provide(ctx.layer),
        );

        expect(states.at(-1)).toEqual({
          _tag: "Failed",
          error: expectedError,
        });
        expect(ctx.requests.map((request) => request.method)).toEqual([
          "get-dependency-tree",
        ]);
      }),
  );

  it.effect("reports a missing controller without calling the server", () =>
    Effect.gen(function* () {
      const ctx = yield* makeContext({
        execute: (request) =>
          Effect.die(`Unexpected method: ${request.method}`),
      });

      const states = yield* collectUntilTerminal(NOTEBOOK_URI).pipe(
        Effect.provide(ctx.layer),
      );

      expect(states.at(-1)).toEqual({
        _tag: "Failed",
        error: "No kernel selected",
      });
      expect(ctx.requests).toEqual([]);
    }),
  );

  it.effect("refreshes a successfully cached dependency tree", () =>
    Effect.gen(function* () {
      const firstTree = { ...TREE, name: "first" };
      const refreshedTree = { ...TREE, name: "refreshed" };
      let request = 0;
      const controller = makeController({ id: "script" });
      const ctx = yield* makeContext({
        controllers: [{ notebookUri: NOTEBOOK_URI, controller }],
        execute: (apiCall) => {
          if (apiCall.method !== "get-dependency-tree") {
            return Effect.die(`Unexpected method: ${apiCall.method}`);
          }
          return Effect.succeed({
            tree: request++ === 0 ? firstTree : refreshedTree,
          });
        },
      });

      yield* inNotebook(
        NOTEBOOK_URI,
        NotebookDependencies.pipe(
          Effect.flatMap((dependencies) =>
            Effect.gen(function* () {
              const initial = yield* dependencies.changes.pipe(
                Stream.takeUntil(isTerminal),
                Stream.runCollect,
              );
              expect(initial.at(-1)).toEqual({
                _tag: "Loaded",
                tree: firstTree,
              });

              const cached = yield* dependencies.changes.pipe(
                Stream.take(1),
                Stream.runHead,
              );
              expect(Option.getOrThrow(cached)).toEqual({
                _tag: "Loaded",
                tree: firstTree,
              });

              yield* dependencies.refresh;
              const refreshed = yield* dependencies.changes.pipe(
                Stream.take(1),
                Stream.runHead,
              );
              expect(Option.getOrThrow(refreshed)).toEqual({
                _tag: "Loaded",
                tree: refreshedTree,
              });
            }),
          ),
        ),
      ).pipe(Effect.provide(ctx.layer));
      expect(ctx.requests).toHaveLength(2);
    }),
  );

  it.effect("does not publish a load invalidated by refresh", () =>
    Effect.gen(function* () {
      const firstRequestStarted = yield* Deferred.make<void>();
      const releaseFirstRequest = yield* Deferred.make<void>();
      const olderTree = { ...TREE, name: "older" };
      const newerTree = { ...TREE, name: "newer" };
      let request = 0;
      const controller = makeController({ id: "script" });
      const ctx = yield* makeContext({
        controllers: [{ notebookUri: NOTEBOOK_URI, controller }],
        execute: (apiCall) => {
          if (apiCall.method !== "get-dependency-tree") {
            return Effect.die(`Unexpected method: ${apiCall.method}`);
          }
          return request++ === 0
            ? Deferred.succeed(firstRequestStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseFirstRequest)),
                Effect.as({ tree: olderTree }),
              )
            : Effect.succeed({ tree: newerTree });
        },
      });

      yield* inNotebook(
        NOTEBOOK_URI,
        NotebookDependencies.pipe(
          Effect.flatMap((dependencies) =>
            Effect.gen(function* () {
              const staleRefresh = yield* dependencies.refresh.pipe(
                Effect.forkChild,
              );
              yield* Deferred.await(firstRequestStarted);

              yield* dependencies.refresh;
              yield* Deferred.succeed(releaseFirstRequest, undefined);
              yield* Fiber.join(staleRefresh);

              const current = yield* dependencies.changes.pipe(
                Stream.take(1),
                Stream.runHead,
              );
              expect(Option.getOrThrow(current)).toEqual({
                _tag: "Loaded",
                tree: newerTree,
              });
            }),
          ),
        ),
      ).pipe(Effect.provide(ctx.layer));
    }),
  );
});
