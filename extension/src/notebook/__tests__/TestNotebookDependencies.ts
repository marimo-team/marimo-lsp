import {
  Context,
  Data,
  Effect,
  Latch,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import {
  makeTestNotebookRuntime,
  type TestCommand,
} from "../../__tests__/__utils__/TestMarimoClient.ts";
import type * as NotebookRuntime from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import type { NotebookId } from "../../schemas/MarimoNotebookDocument.ts";
import type { DependencyTreeNode } from "../../schemas/Models.gen.ts";
import * as NotebookDependencies from "../NotebookDependencies.ts";
import * as NotebookDocumentSessions from "../NotebookDocumentSessions.ts";
import * as NotebookSessionResources from "../NotebookSessionResources.ts";

export const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
export const OTHER_NOTEBOOK_URI = notebookId("file:///test/other.py");

export const TREE: DependencyTreeNode = {
  name: "<root>",
  version: null,
  tags: [],
  dependencies: [],
};

export type Scenario = Data.TaggedEnum<{
  ControllerOwnership: {};
  SharedLoad: {};
  PythonFallback: {};
  ScriptFailure: {};
  MissingController: {};
  Refresh: {};
  InvalidatedRefresh: {};
}>;
export const Scenario = Data.taggedEnum<Scenario>();

export interface Interface {
  readonly requests: Effect.Effect<ReadonlyArray<TestCommand>>;
  readonly collect: (options?: {
    readonly notebookId?: NotebookId;
    readonly onState?: Effect.Effect<unknown>;
  }) => Effect.Effect<ReadonlyArray<NotebookDependencies.State>>;
  readonly current: (
    notebookId?: NotebookId,
  ) => Effect.Effect<NotebookDependencies.State>;
  readonly refresh: (notebookId?: NotebookId) => Effect.Effect<void>;
  readonly requestStarted: Effect.Effect<void>;
  readonly releaseRequest: Effect.Effect<void>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/test/NotebookDependencies",
) {}

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

const isTerminal = (state: NotebookDependencies.State) =>
  state._tag === "Loaded" || state._tag === "Failed";

export const layerWith = (scenario: Scenario) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<TestCommand>>([]);
      const requestStarted = yield* Latch.make();
      const releaseRequest = yield* Latch.make();
      let request = 0;

      const notebookIds = Scenario.$is("ControllerOwnership")(scenario)
        ? [NOTEBOOK_URI, OTHER_NOTEBOOK_URI]
        : [NOTEBOOK_URI];
      const documents = notebookIds.map((uri) =>
        TestVsCode.createTestNotebookDocument(TestVsCode.Uri.parse(uri)),
      );
      const controllers: ReadonlyArray<NotebookRuntime.NotebookControllerSelection> =
        Scenario.$is("ControllerOwnership")(scenario)
          ? [
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
            ]
          : Scenario.$is("MissingController")(scenario)
            ? []
            : [
                {
                  notebookUri: NOTEBOOK_URI,
                  controller: makeController(
                    Scenario.$is("PythonFallback")(scenario)
                      ? {
                          id: "python",
                          executable: "/test/.venv/bin/python",
                        }
                      : { id: "script" },
                  ),
                },
              ];

      const send = (
        command: TestCommand,
      ): Effect.Effect<unknown, Schema.SchemaError> => {
        if (Scenario.$is("MissingController")(scenario)) {
          return Effect.die(`Unexpected command: ${command.kind}`);
        }
        if (Scenario.$is("SharedLoad")(scenario)) {
          return requestStarted.open.pipe(
            Effect.andThen(releaseRequest.await),
            Effect.as({ tree: TREE }),
          );
        }
        if (Scenario.$is("PythonFallback")(scenario)) {
          return command.kind === "get-dependency-tree"
            ? Schema.decodeUnknownEffect(Schema.Number)("invalid")
            : Effect.succeed({
                packages: [{ name: "effect", version: "4.0.0" }],
              });
        }
        if (Scenario.$is("ScriptFailure")(scenario)) {
          return Schema.decodeUnknownEffect(Schema.Number)("invalid");
        }
        if (Scenario.$is("Refresh")(scenario)) {
          if (command.kind !== "get-dependency-tree") {
            return Effect.die(`Unexpected command: ${command.kind}`);
          }
          return Effect.succeed({
            tree: { ...TREE, name: request++ === 0 ? "first" : "refreshed" },
          });
        }
        if (Scenario.$is("InvalidatedRefresh")(scenario)) {
          if (command.kind !== "get-dependency-tree") {
            return Effect.die(`Unexpected command: ${command.kind}`);
          }
          return request++ === 0
            ? requestStarted.open.pipe(
                Effect.andThen(releaseRequest.await),
                Effect.as({ tree: { ...TREE, name: "older" } }),
              )
            : Effect.succeed({ tree: { ...TREE, name: "newer" } });
        }
        return Effect.succeed({ tree: TREE });
      };

      const vscodeLayer = TestVsCode.layerWith({
        initialDocuments: documents,
      });
      const runtimeLayer = makeTestNotebookRuntime({
        initialControllers: controllers,
        send: (command) =>
          Ref.update(requests, (current) => [...current, command]).pipe(
            Effect.andThen(send(command)),
          ),
      });
      const sessionsLayer = NotebookDocumentSessions.layer.pipe(
        Layer.provide(vscodeLayer),
      );
      const resourcesLayer = NotebookSessionResources.layer.pipe(
        Layer.provide(sessionsLayer),
        Layer.provide(runtimeLayer),
      );
      const environment = Layer.mergeAll(
        vscodeLayer,
        sessionsLayer,
        resourcesLayer,
      );
      const fixture = Layer.effect(
        Service,
        Effect.gen(function* () {
          const sessions = yield* NotebookDocumentSessions.Service;
          const resources = yield* NotebookSessionResources.Service;

          const inNotebook = <A, E, R>(
            id: NotebookId,
            effect: Effect.Effect<A, E, R>,
          ) => {
            const session = sessions.current(id);
            if (Option.isNone(session)) {
              return Effect.die(`Expected an open session for ${id}`);
            }
            return resources
              .runScoped(session.value, effect)
              .pipe(Scope.provide(session.value.scope), Effect.orDie);
          };

          const dependencies = (id: NotebookId) =>
            inNotebook(id, NotebookDependencies.Service);

          return Service.of({
            requests: Ref.get(requests),
            collect: (options = {}) =>
              dependencies(options.notebookId ?? NOTEBOOK_URI).pipe(
                Effect.flatMap((service) =>
                  service.changes.pipe(
                    Stream.tap(() => options.onState ?? Effect.void),
                    Stream.takeUntil(isTerminal),
                    Stream.runCollect,
                  ),
                ),
                Effect.map((states) => Array.from(states)),
              ),
            current: (id = NOTEBOOK_URI) =>
              dependencies(id).pipe(
                Effect.flatMap((service) =>
                  service.changes.pipe(Stream.take(1), Stream.runHead),
                ),
                Effect.map(Option.getOrThrow),
              ),
            refresh: (id = NOTEBOOK_URI) =>
              dependencies(id).pipe(
                Effect.flatMap((service) => service.refresh),
              ),
            requestStarted: requestStarted.await,
            releaseRequest: releaseRequest.open.pipe(Effect.asVoid),
          });
        }),
      ).pipe(Layer.provide(environment));

      return Layer.merge(environment, fixture);
    }),
  );

export const layer = layerWith(Scenario.ControllerOwnership());
