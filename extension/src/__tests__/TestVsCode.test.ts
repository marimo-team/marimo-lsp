import { assert, describe, expect, it } from "@effect/vitest";
import { Chunk, Effect, Fiber, Option, Stream } from "effect";

import { TestVsCode } from "../__mocks__/TestVsCode.ts";
import { VsCode } from "../services/VsCode.ts";

// Tests for our VsCode test harness
describe("TestVsCode", () => {
  it.effect(
    "defaults to None active editor",
    Effect.fnUntraced(function* () {
      const vscode = yield* TestVsCode.make();

      const editor = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const editor = yield* code.window.getActiveNotebookEditor();
        return editor;
      }).pipe(Effect.provide(vscode.layer));

      assert.strictEqual(editor._tag, "None");
    }),
  );

  it.effect(
    "supports initializing with notebook documents",
    Effect.fnUntraced(function* () {
      const editor1 = TestVsCode.makeNotebookEditor("/test/foo_mo.py");
      const editor2 = TestVsCode.makeNotebookEditor("/test/bar_mo.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor1.notebook, editor2.notebook],
      });

      const documents = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        const documents = yield* code.workspace.getNotebookDocuments();
        return documents.map((doc) => doc.uri.toString()).toSorted();
      }).pipe(Effect.provide(vscode.layer));

      expect(documents).toMatchInlineSnapshot(`
        [
          "file:///test/bar_mo.py",
          "file:///test/foo_mo.py",
        ]
      `);
    }),
  );

  it.effect(
    "supports setting notebook editor",
    Effect.fnUntraced(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/foo_mo.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
      });

      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      const activeEditor = yield* Effect.gen(function* () {
        const code = yield* VsCode;
        return yield* code.window.getActiveNotebookEditor();
      }).pipe(Effect.provide(vscode.layer));

      assert(activeEditor._tag === "Some");
      expect(editor).toBe(activeEditor.value);
    }),
  );

  it.effect(
    "should emit changes to active editor stream",
    Effect.fnUntraced(function* () {
      const editors = [
        TestVsCode.makeNotebookEditor("/test/foo_mo.py"),
        TestVsCode.makeNotebookEditor("/test/foo_mo.py"),
        TestVsCode.makeNotebookEditor("/test/foo_mo.py"),
      ];
      const vscode = yield* TestVsCode.make({
        initialDocuments: editors.map((e) => e.notebook),
      });

      const result = yield* Effect.gen(function* () {
        const code = yield* VsCode;

        const fiber = yield* code.window
          .activeNotebookEditorChanges()
          .pipe(Stream.take(5), Stream.runCollect, Effect.fork);

        yield* Effect.yieldNow();
        yield* vscode.setActiveNotebookEditor(Option.some(editors[0]));

        yield* Effect.yieldNow();
        yield* vscode.setActiveNotebookEditor(Option.some(editors[1]));

        yield* Effect.yieldNow();
        yield* vscode.setActiveNotebookEditor(Option.some(editors[2]));

        yield* Effect.yieldNow();
        yield* vscode.setActiveNotebookEditor(Option.some(editors[2]));

        yield* Effect.yieldNow();
        yield* vscode.setActiveNotebookEditor(Option.none());

        const chunk = yield* Fiber.join(fiber);
        return Chunk.toReadonlyArray(chunk).map(
          Option.map((n) => n.notebook.uri.toString()),
        );
      }).pipe(Effect.provide(vscode.layer));

      expect(result).toMatchInlineSnapshot(`
        [
          {
            "_id": "Option",
            "_tag": "Some",
            "value": "file:///test/foo_mo.py",
          },
          {
            "_id": "Option",
            "_tag": "Some",
            "value": "file:///test/foo_mo.py",
          },
          {
            "_id": "Option",
            "_tag": "Some",
            "value": "file:///test/foo_mo.py",
          },
          {
            "_id": "Option",
            "_tag": "Some",
            "value": "file:///test/foo_mo.py",
          },
          {
            "_id": "Option",
            "_tag": "None",
          },
        ]
      `);
    }),
  );
});
