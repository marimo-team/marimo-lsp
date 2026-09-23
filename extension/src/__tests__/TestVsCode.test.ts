import { assert, describe, expect } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import type * as vscode from "vscode";

import * as TestVsCode from "../__mocks__/TestVsCode.ts";
import * as VsCode from "../platform/VsCode.ts";
import { makeActiveNotebookEditorChanges } from "../platform/Window.ts";
import { makeNotebookLifecycle } from "../platform/Workspace.ts";
import * as EffectTest from "./__utils__/EffectTest.ts";

const it = EffectTest.make(TestVsCode.layer);
const initialEditors = [
  TestVsCode.makeNotebookEditor("/test/foo_mo.py"),
  TestVsCode.makeNotebookEditor("/test/bar_mo.py"),
];
const initializedIt = EffectTest.make(
  TestVsCode.layerWith({
    initialDocuments: initialEditors.map((editor) => editor.notebook),
  }),
);

// Tests for our VsCode test harness
describe("TestVsCode", () => {
  it.effect(
    "defaults to None active editor",
    Effect.fn(function* () {
      const test = yield* TestVsCode.Service;
      const code = yield* VsCode.Service;
      const editor = yield* code.window.getActiveNotebookEditor;

      assert.strictEqual(editor._tag, "None");
      expect((yield* test.snapshot).activeNotebookUri).toEqual(Option.none());
    }),
  );

  initializedIt.effect(
    "supports initializing with notebook documents",
    Effect.fn(function* () {
      const code = yield* VsCode.Service;
      const documents = (yield* code.workspace.getNotebookDocuments)
        .map((doc) => doc.uri.toString())
        .toSorted();

      expect(documents).toMatchInlineSnapshot(`
        [
          "file:///test/bar_mo.py",
          "file:///test/foo_mo.py",
        ]
      `);
    }),
  );

  it.effect(
    "subscribes before emitting the active notebook editor snapshot",
    Effect.fn(function* () {
      const initial = TestVsCode.makeNotebookEditor("/test/initial_mo.py");
      const next = TestVsCode.makeNotebookEditor("/test/next_mo.py");
      const initialObserved = yield* Deferred.make<void>();
      let listener:
        | ((editor: vscode.NotebookEditor | undefined) => unknown)
        | undefined;
      let disposals = 0;
      const changes = makeActiveNotebookEditorChanges({
        get activeNotebookEditor() {
          expect(listener).toBeDefined();
          return initial;
        },
        onDidChangeActiveNotebookEditor(callback) {
          listener = callback;
          return {
            dispose() {
              disposals += 1;
              listener = undefined;
            },
          };
        },
      });

      const result = yield* changes.pipe(
        Stream.tap(() => Deferred.succeed(initialObserved, undefined)),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(initialObserved);
      listener?.(next);

      const editors = Array.from(yield* Fiber.join(result)).map(
        Option.map((editor) => editor.notebook.uri.toString()),
      );
      expect(editors).toEqual([
        Option.some("file:///test/initial_mo.py"),
        Option.some("file:///test/next_mo.py"),
      ]);
      expect(disposals).toBe(1);
    }),
  );

  it.effect(
    "keeps notebook lifecycle events and the document snapshot consistent",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/foo_mo.py");
      const vscode = yield* TestVsCode.Service;
      const code = yield* VsCode.Service;

      // Open before subscribing: the document must still appear in the
      // lifecycle snapshot instead of being lost between independent stores.
      yield* vscode.openNotebook(editor.notebook);
      const lifecycle = yield* code.workspace.subscribeNotebookLifecycle;
      const opened = yield* Stream.runHead(lifecycle);
      expect(Option.map(opened, (event) => event.type)).toEqual(
        Option.some("opened"),
      );
      expect(yield* code.workspace.getNotebookDocuments).toContain(
        editor.notebook,
      );

      const closeLifecycle = yield* code.workspace.subscribeNotebookLifecycle;
      const closedFiber = yield* closeLifecycle.pipe(
        Stream.filter((event) => event.type === "closed"),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* vscode.closeNotebook(editor.notebook);
      const closed = yield* Fiber.join(closedFiber);
      expect(Option.map(closed, (event) => event.document)).toEqual(
        Option.some(editor.notebook),
      );
      expect(yield* code.workspace.getNotebookDocuments).not.toContain(
        editor.notebook,
      );
    }),
  );

  it.effect(
    "disposes notebook lifecycle listeners when its consumer ends",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/notebook_mo.py");
      let opened: ((document: vscode.NotebookDocument) => unknown) | undefined;
      let closed: ((document: vscode.NotebookDocument) => unknown) | undefined;
      let disposals = 0;
      const lifecycle = yield* makeNotebookLifecycle({
        notebookDocuments: [],
        onDidOpenNotebookDocument: (listener) => {
          opened = listener;
          return {
            dispose() {
              disposals += 1;
              opened = undefined;
            },
          };
        },
        onDidCloseNotebookDocument: (listener) => {
          closed = listener;
          return {
            dispose() {
              disposals += 1;
              closed = undefined;
            },
          };
        },
      });

      const consumer = yield* lifecycle.pipe(
        Stream.take(1),
        Stream.runDrain,
        Effect.forkChild,
      );
      opened?.(editor.notebook);
      yield* Fiber.join(consumer);

      expect(disposals).toBe(2);
      expect(opened).toBeUndefined();
      expect(closed).toBeUndefined();
    }),
  );

  it.effect(
    "supports setting notebook editor",
    Effect.fn(function* () {
      const editor = TestVsCode.makeNotebookEditor("/test/foo_mo.py");
      const vscode = yield* TestVsCode.Service;
      const code = yield* VsCode.Service;

      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      const activeEditor = yield* code.window.getActiveNotebookEditor;

      assert(activeEditor._tag === "Some");
      expect(editor).toBe(activeEditor.value);
    }),
  );

  it.effect(
    "should emit changes to active editor stream",
    Effect.fn(function* () {
      const editors = [
        TestVsCode.makeNotebookEditor("/test/foo_mo1.py"),
        TestVsCode.makeNotebookEditor("/test/foo_mo2.py"),
        TestVsCode.makeNotebookEditor("/test/foo_mo3.py"),
      ];
      const vscode = yield* TestVsCode.Service;
      const code = yield* VsCode.Service;

      yield* Effect.forEach(editors, (editor) =>
        vscode.openNotebook(editor.notebook),
      );

      // `SubscriptionRef.changes` sends the current value at
      // subscription. Expect the first None and the five updates below.
      const fiber = yield* code.window.activeNotebookEditorChanges.pipe(
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editors[0]));

      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editors[1]));

      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editors[2]));

      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.some(editors[2]));

      yield* Effect.yieldNow;
      yield* vscode.setActiveNotebookEditor(Option.none());

      const collected = yield* Fiber.join(fiber);
      const result = collected.map(
        Option.map((notebookEditor) => notebookEditor.notebook.uri.toString()),
      );

      expect(result.map(Option.getOrNull)).toMatchInlineSnapshot(`
        [
          null,
          "file:///test/foo_mo1.py",
          "file:///test/foo_mo2.py",
          "file:///test/foo_mo3.py",
          "file:///test/foo_mo3.py",
          null,
        ]
      `);
    }),
  );
});
