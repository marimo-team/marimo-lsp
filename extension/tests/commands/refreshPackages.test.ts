import * as Vitest from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref } from "effect";

import refreshPackages from "../../src/commands/refreshPackages.ts";
import type * as NotebookRuntime from "../../src/kernel/NotebookRuntime.ts";
import * as NotebookDocumentSessions from "../../src/notebook/NotebookDocumentSessions.ts";
import * as NotebookEditorRegistry from "../../src/notebook/NotebookEditorRegistry.ts";
import * as NotebookSessionResources from "../../src/notebook/NotebookSessionResources.ts";
import * as NotebookRuntimeTest from "../fake/NotebookRuntime.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { notebookId } from "../lib/branded.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const document = VsCodeTest.createTestNotebookDocument(
  VsCodeTest.Uri.parse(NOTEBOOK_URI),
);

const controller: NotebookRuntime.NotebookController = {
  id: "script",
  drive: () => () => Effect.void,
  presentOutputs: () => Effect.void,
  resolveExecutable: () => Effect.succeed("/unused/python"),
};

interface RequestTrackerInterface {
  readonly record: Effect.Effect<void>;
  readonly count: Effect.Effect<number>;
}

class RequestTracker extends Context.Service<
  RequestTracker,
  RequestTrackerInterface
>()("@test/refreshPackages/RequestTracker") {}

const requestTrackerLayer = Layer.effect(
  RequestTracker,
  Effect.gen(function* () {
    const count = yield* Ref.make(0);
    return RequestTracker.of({
      record: Ref.update(count, (value) => value + 1),
      count: Ref.get(count),
    });
  }),
);

const vscodeLayer = VsCodeTest.layerWith({ initialDocuments: [document] });
const runtimeLayer = Layer.unwrap(
  RequestTracker.pipe(
    Effect.map((requests) =>
      NotebookRuntimeTest.layerWith({
        initialControllers: [{ notebookUri: NOTEBOOK_URI, controller }],
        send: (request) =>
          request.kind === "get-dependency-tree"
            ? requests.record.pipe(
                Effect.as({
                  tree: {
                    name: "<root>",
                    version: null,
                    tags: [],
                    dependencies: [],
                  },
                }),
              )
            : Effect.die(`Unexpected command: ${request.kind}`),
      }),
    ),
  ),
).pipe(Layer.provideMerge(requestTrackerLayer));
const sessionsLayer = NotebookDocumentSessions.layer.pipe(
  Layer.provide(vscodeLayer),
);
const resourcesLayer = NotebookSessionResources.layer.pipe(
  Layer.provide(sessionsLayer),
  Layer.provide(runtimeLayer),
);
const editorRegistryLayer = Layer.mock(NotebookEditorRegistry.Service, {
  getActiveNotebookUri: Effect.succeed(Option.some(NOTEBOOK_URI)),
});

const it = EffectTest.make(
  Layer.mergeAll(
    vscodeLayer,
    runtimeLayer,
    sessionsLayer,
    resourcesLayer,
    editorRegistryLayer,
  ),
);

it.effect("refreshes dependencies for the active document session", () =>
  Effect.gen(function* () {
    const requests = yield* RequestTracker;

    yield* refreshPackages.invoke();

    Vitest.expect(yield* requests.count).toBe(1);
  }),
);
