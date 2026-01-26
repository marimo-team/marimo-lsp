import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream, TestClock } from "effect";
import { TestTelemetryLive } from "../../__mocks__/TestTelemetry.ts";
import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { NotebookEditorRegistry } from "../NotebookEditorRegistry.ts";
import { VsCode } from "../VsCode.ts";

function makeRegistryLayer(vscode: TestVsCode) {
  return Layer.empty.pipe(
    Layer.provideMerge(NotebookEditorRegistry.Default),
    Layer.provide(TestTelemetryLive),
    Layer.provideMerge(vscode.layer),
  );
}

it.effect(
  "should return None when no active notebook editor",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    yield* Effect.provide(
      Effect.gen(function* () {
        const registry = yield* NotebookEditorRegistry;

        const activeUri = yield* registry.getActiveNotebookUri();
        expect(Option.isNone(activeUri)).toBe(true);

        const activeEditor = yield* registry.getActiveNotebookEditor();
        expect(Option.isNone(activeEditor)).toBe(true);
      }),
      makeRegistryLayer(vscode),
    );
  }),
);

it.effect(
  "should track active notebook editor changes",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;
        const registry = yield* NotebookEditorRegistry;

        // Create a mock notebook
        const notebook = createTestNotebookDocument(
          code.Uri.file("/test/notebook_mo.py"),
        );

        // Create a mock notebook editor
        const mockEditor = createTestNotebookEditor(notebook);

        // Initially, no active editor
        const initialActive = yield* registry.getActiveNotebookUri();
        expect(Option.isNone(initialActive)).toBe(true);

        // Set active notebook editor
        yield* vscode.setActiveNotebookEditor(Option.some(mockEditor));

        // Tick
        yield* TestClock.adjust("10 millis");

        // Verify the registry tracked the change
        const activeUri = yield* registry.getActiveNotebookUri();
        expect(Option.isSome(activeUri)).toBe(true);
        if (Option.isSome(activeUri)) {
          expect(activeUri.value).toBe(notebook.uri.toString());
        }

        // Verify we can get the editor back
        const editor = yield* registry.getActiveNotebookEditor();
        expect(Option.isSome(editor)).toBe(true);
        if (Option.isSome(editor)) {
          expect(editor.value.notebook.uri.toString()).toBe(
            notebook.uri.toString(),
          );
        }

        // Clear active editor
        yield* vscode.setActiveNotebookEditor(Option.none());
        yield* TestClock.adjust("10 millis");

        const clearedActive = yield* registry.getActiveNotebookUri();
        expect(Option.isNone(clearedActive)).toBe(true);
      }),
      makeRegistryLayer(vscode),
    );
  }),
);

it.effect(
  "should track stream of active notebook editor changes",
  Effect.fnUntraced(function* () {
    const vscode = yield* TestVsCode.make();

    yield* Effect.provide(
      Effect.gen(function* () {
        const code = yield* VsCode;
        const registry = yield* NotebookEditorRegistry;

        const stream = registry.streamActiveNotebookChanges();
        const mockEditor = createTestNotebookEditor(
          createTestNotebookDocument(
            code.Uri.file("file:///test/notebook_mo.py"),
          ),
        );
        const otherEditor = createTestNotebookEditor(
          createTestNotebookDocument(
            code.Uri.file("file:///test/notebook_other.py"),
          ),
        );

        // Create a stream and fork
        const streamResult = yield* Effect.fork(
          stream.pipe(Stream.take(4)).pipe(Stream.runCollect),
        );

        const changes = [
          Option.some(mockEditor),
          Option.none(),
          Option.some(otherEditor),
          Option.some(otherEditor),
          Option.some(mockEditor),
        ];

        for (const change of changes) {
          yield* vscode.setActiveNotebookEditor(change);
          yield* TestClock.adjust("10 millis");
        }

        const collected = yield* streamResult;
        expect(collected).toMatchInlineSnapshot(`
          {
            "_id": "Chunk",
            "values": [
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
            ],
          }
        `);
      }),
      makeRegistryLayer(vscode),
    );
  }),
);
