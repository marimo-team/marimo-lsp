import { expect } from "@effect/vitest";
import { Context, Effect, Layer, Option, Ref } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import type * as NotebookRuntime from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import * as NotebookEditorRegistry from "../../notebook/NotebookEditorRegistry.ts";
import * as NotebookSessionResources from "../../notebook/NotebookSessionResources.ts";
import refreshPackages from "../refreshPackages.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");
const document = TestVsCode.createTestNotebookDocument(
  TestVsCode.Uri.parse(NOTEBOOK_URI),
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

const vscodeLayer = TestVsCode.layerWith({ initialDocuments: [document] });
const runtimeLayer = Layer.unwrap(
  RequestTracker.pipe(
    Effect.map((requests) =>
      makeTestNotebookRuntime({
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

    expect(yield* requests.count).toBe(1);
  }),
);
