import * as Vitest from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Stream } from "effect";

import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as NotebookEditorRegistry from "../../notebook/NotebookEditorRegistry.ts";

const it = EffectTest.make(
  NotebookEditorRegistry.layer.pipe(
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(TestVsCode.layer),
  ),
);
const initiallyActiveEditor = TestVsCode.createTestNotebookEditor(
  TestVsCode.createTestNotebookDocument("/test/already-active_mo.py"),
);
const initiallyActiveIt = EffectTest.make(
  NotebookEditorRegistry.layer.pipe(
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(
      TestVsCode.layerWith({
        initialActiveNotebookEditor: Option.some(initiallyActiveEditor),
      }),
    ),
  ),
);

const awaitActive = (
  registry: NotebookEditorRegistry.Interface,
  expected: Option.Option<string>,
) =>
  registry.streamActiveNotebookChanges.pipe(
    Stream.filter((actual) =>
      Option.match(expected, {
        onNone: () => Option.isNone(actual),
        onSome: (id) => Option.isSome(actual) && actual.value === id,
      }),
    ),
    Stream.runHead,
    Effect.asVoid,
  );

it.effect(
  "should return None when no active notebook editor",
  Effect.fn(function* () {
    const registry = yield* NotebookEditorRegistry.Service;

    const activeUri = yield* registry.getActiveNotebookUri;
    Vitest.expect(Option.isNone(activeUri)).toBe(true);

    const activeEditor = yield* registry.getActiveNotebookEditor;
    Vitest.expect(Option.isNone(activeEditor)).toBe(true);
  }),
);

initiallyActiveIt.effect(
  "should seed an already-active notebook editor",
  Effect.fn(function* () {
    const registry = yield* NotebookEditorRegistry.Service;

    Vitest.expect(yield* registry.getActiveNotebookUri).toEqual(
      Option.some(initiallyActiveEditor.notebook.uri.toString()),
    );
    Vitest.expect(yield* registry.getActiveNotebookEditor).toEqual(
      Option.some(initiallyActiveEditor),
    );
  }),
);

it.effect(
  "should track active notebook editor changes",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const registry = yield* NotebookEditorRegistry.Service;

    const notebook = TestVsCode.createTestNotebookDocument(
      TestVsCode.Uri.file("/test/notebook_mo.py"),
    );
    const mockEditor = TestVsCode.createTestNotebookEditor(notebook);

    const initialActive = yield* registry.getActiveNotebookUri;
    Vitest.expect(Option.isNone(initialActive)).toBe(true);

    yield* vscode.setActiveNotebookEditor(Option.some(mockEditor));
    yield* awaitActive(registry, Option.some(notebook.uri.toString()));

    const activeUri = yield* registry.getActiveNotebookUri;
    Vitest.expect(Option.isSome(activeUri)).toBe(true);
    if (Option.isSome(activeUri)) {
      Vitest.expect(activeUri.value).toBe(notebook.uri.toString());
    }

    const editor = yield* registry.getActiveNotebookEditor;
    Vitest.expect(Option.isSome(editor)).toBe(true);
    if (Option.isSome(editor)) {
      Vitest.expect(editor.value.notebook.uri.toString()).toBe(
        notebook.uri.toString(),
      );
    }

    yield* vscode.setActiveNotebookEditor(Option.none());
    yield* awaitActive(registry, Option.none());

    const clearedActive = yield* registry.getActiveNotebookUri;
    Vitest.expect(Option.isNone(clearedActive)).toBe(true);
  }),
);

it.effect(
  "should track stream of active notebook editor changes",
  Effect.fn(function* () {
    const vscode = yield* TestVsCode.Service;
    const registry = yield* NotebookEditorRegistry.Service;

    const stream = registry.streamActiveNotebookChanges;
    const mockEditor = TestVsCode.createTestNotebookEditor(
      TestVsCode.createTestNotebookDocument(
        TestVsCode.Uri.file("file:///test/notebook_mo.py"),
      ),
    );
    const otherEditor = TestVsCode.createTestNotebookEditor(
      TestVsCode.createTestNotebookDocument(
        TestVsCode.Uri.file("file:///test/notebook_other.py"),
      ),
    );

    const subscriptionReady = yield* Deferred.make<void>();
    const streamResult = yield* Effect.forkChild(
      stream.pipe(
        Stream.tap(() => Deferred.succeed(subscriptionReady, undefined)),
        Stream.drop(1),
        Stream.take(4),
        Stream.runCollect,
      ),
    );
    yield* Deferred.await(subscriptionReady);

    const changes = [
      Option.some(mockEditor),
      Option.none(),
      Option.some(otherEditor),
      Option.some(otherEditor),
      Option.some(mockEditor),
    ];

    for (const change of changes) {
      yield* vscode.setActiveNotebookEditor(change);
    }

    const collected = yield* Fiber.join(streamResult);
    Vitest.expect(collected).toMatchInlineSnapshot(`
          [
            {
              "_id": "Option",
              "_tag": "Some",
              "value": "file:///file:///test/notebook_mo.py",
            },
            {
              "_id": "Option",
              "_tag": "None",
            },
            {
              "_id": "Option",
              "_tag": "Some",
              "value": "file:///file:///test/notebook_other.py",
            },
            {
              "_id": "Option",
              "_tag": "Some",
              "value": "file:///file:///test/notebook_mo.py",
            },
          ]
        `);
  }),
);
