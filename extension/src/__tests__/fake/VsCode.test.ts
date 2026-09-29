import * as Vitest from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Stream } from "effect";
import type * as vscode from "vscode";

import { commandId, defineCommand } from "../../commands.ts";
import { MarimoCommands } from "../../commands/MarimoCommands.ts";
import * as VsCode from "../../platform/VsCode.ts";
import { makeActiveNotebookEditorChanges } from "../../platform/Window.ts";
import { makeNotebookLifecycle } from "../../platform/Workspace.ts";
import * as EffectTest from "../lib/EffectTest.ts";
import * as VsCodeTest from "./VsCode.ts";

const it = EffectTest.make(VsCodeTest.layer);
const initialEditors = [
  VsCodeTest.makeNotebookEditor("/test/foo_mo.py"),
  VsCodeTest.makeNotebookEditor("/test/bar_mo.py"),
];
const initializedIt = EffectTest.make(
  VsCodeTest.layerWith({
    initialDocuments: initialEditors.map((editor) => editor.notebook),
  }),
);

// Tests for our VsCode test harness
Vitest.describe("VsCodeTest", () => {
  it.effect(
    "keeps text editor snapshots consistent when activation repeats",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      const editor = VsCodeTest.createTestTextEditor(
        VsCodeTest.createTestTextDocument("/test/a.py", "python", "x = 1"),
      );
      yield* test.setActiveTextEditor(Option.some(editor));
      yield* test.setActiveTextEditor(Option.some(editor));
      Vitest.expect(yield* code.window.getActiveTextEditor).toEqual(
        Option.some(editor),
      );
      Vitest.expect(yield* code.window.getVisibleTextEditors).toEqual([editor]);
      Vitest.expect(yield* code.workspace.getTextDocuments).toEqual([
        editor.document,
      ]);
    }),
  );

  it.effect(
    "releases registrations when their scope closes",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* code.commands.register(
            defineCommand(MarimoCommands.restartLsp, () => Effect.void),
          );
          yield* code.notebooks.createNotebookController(
            "controller",
            "test",
            "Test",
          );
          yield* code.workspace.registerNotebookSerializer("test", {
            deserializeNotebook: () => new code.NotebookData([]),
            serializeNotebook: () => new Uint8Array(),
          });
          yield* code.window.createTreeView("view", {
            treeDataProvider: {
              getTreeItem: (item: vscode.TreeItem) => item,
              getChildren: () => [],
            },
          });
          yield* code.notebooks.registerNotebookCellStatusBarItemProvider(
            "test",
            {
              provideCellStatusBarItems: () => Effect.succeed([]),
              changes: Stream.empty,
            },
          );
          const snapshot = yield* test.snapshot;
          Vitest.expect(snapshot.commands).toEqual([
            commandId(MarimoCommands.restartLsp),
          ]);
          Vitest.expect(snapshot.controllers).toEqual(["controller"]);
          Vitest.expect(snapshot.serializers).toEqual(["test"]);
          Vitest.expect(snapshot.views).toEqual(["view"]);
          Vitest.expect(yield* test.statusBarProviders).toHaveLength(1);
        }),
      );
      const snapshot = yield* test.snapshot;
      Vitest.expect([
        snapshot.commands,
        snapshot.controllers,
        snapshot.serializers,
        snapshot.views,
      ]).toEqual([[], [], [], []]);
      Vitest.expect(yield* test.statusBarProviders).toEqual([]);
    }),
  );

  it.effect(
    "records commands without changing earlier snapshots",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      yield* code.commands.setContext("marimo.notebook.hasKernel", true);
      const before = yield* test.snapshot;
      yield* code.commands.setContext("marimo.notebook.hasKernel", false);
      Vitest.expect(before.executions).toEqual([
        { command: "setContext", args: ["marimo.notebook.hasKernel", true] },
      ]);
      Vitest.expect((yield* test.snapshot).executions).toHaveLength(2);
    }),
  );

  it.effect(
    "delivers renderer messages and removes disposed listeners",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      const editor = VsCodeTest.makeNotebookEditor("/test/renderer.py");
      const channel = yield* code.notebooks.createRendererMessaging("test");
      const received: unknown[] = [];
      const listener = channel.onDidReceiveMessage((message) =>
        received.push(message),
      );
      yield* test.rendererMessaging.ready;
      const request = {
        command: "copy-image" as const,
        params: { src: "image.png", requestId: "request" },
      };
      yield* test.rendererMessaging.send(editor, request);
      Vitest.expect(received).toEqual([{ editor, message: request }]);
      const reply = {
        op: "image-data-result" as const,
        requestId: "request",
        dataUri: null,
      };
      yield* Effect.promise(() => channel.postMessage(reply, editor));
      Vitest.expect(yield* test.rendererMessaging.receive).toEqual(reply);
      listener.dispose();
      yield* test.rendererMessaging.send(editor, request);
      Vitest.expect(received).toHaveLength(1);
    }),
  );

  it.effect(
    "scripts input responses and observes prompt cancellation",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      yield* test.respondToInput(Option.some("answer"));
      Vitest.expect(
        yield* code.window.showInputBox({ prompt: "First" }),
      ).toEqual(Option.some("answer"));
      const pending = yield* code.window
        .showInputBox({ prompt: "Second" })
        .pipe(Effect.forkChild);
      yield* test.inputChanges.pipe(
        Stream.filter((inputs) =>
          inputs.some((input) => input.options?.prompt === "Second"),
        ),
        Stream.runHead,
      );
      yield* Fiber.interrupt(pending);
      Vitest.expect((yield* test.snapshot).inputs).toEqual([
        { options: { prompt: "First" }, status: "responded" },
        { options: { prompt: "Second" }, status: "cancelled" },
      ]);
    }),
  );

  it.effect(
    "defaults to None active editor",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      const editor = yield* code.window.getActiveNotebookEditor;

      Vitest.assert.strictEqual(editor._tag, "None");
      Vitest.expect((yield* test.snapshot).activeNotebookUri).toEqual(
        Option.none(),
      );
    }),
  );

  initializedIt.effect(
    "supports initializing with notebook documents",
    Effect.fn(function* () {
      const code = yield* VsCode.Service;
      const documents = (yield* code.workspace.getNotebookDocuments)
        .map((doc) => doc.uri.toString())
        .toSorted();

      Vitest.expect(documents).toMatchInlineSnapshot(`
        [
          "file:///test/bar_mo.py",
          "file:///test/foo_mo.py",
        ]
      `);
    }),
  );

  it.effect(
    "scripts and records quick-pick interactions",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;

      yield* test.selectQuickPick("Second");
      const single = yield* code.window.showQuickPickItems(
        [
          { label: "First", description: "one" },
          { label: "Second", description: "two" },
        ],
        { title: "Choose one" },
      );

      yield* test.selectQuickPickMany(["HTML", "IPYNB"]);
      const many = yield* code.window.showQuickPickItemsMany(
        [{ label: "HTML" }, { label: "Markdown" }, { label: "IPYNB" }],
        { title: "Choose formats" },
      );

      Vitest.expect(Option.getOrThrow(single).label).toBe("Second");
      Vitest.expect(Option.getOrThrow(many).map((item) => item.label)).toEqual([
        "HTML",
        "IPYNB",
      ]);
      Vitest.expect((yield* test.snapshot).quickPicks).toEqual([
        {
          items: [
            { label: "First", description: "one", detail: undefined },
            { label: "Second", description: "two", detail: undefined },
          ],
          title: "Choose one",
          canPickMany: false,
        },
        {
          items: [
            { label: "HTML", description: undefined, detail: undefined },
            { label: "Markdown", description: undefined, detail: undefined },
            { label: "IPYNB", description: undefined, detail: undefined },
          ],
          title: "Choose formats",
          canPickMany: true,
        },
      ]);
    }),
  );

  it.effect(
    "records window messages",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;

      yield* test.selectInformationMessage("Open");
      const selected = yield* code.window.showInformationMessage("Saved", {
        items: ["Dismiss", "Open"],
      });
      yield* code.window.showWarningMessage("Missing notebook");
      yield* code.window.showErrorMessage("Save failed");

      Vitest.expect(selected).toEqual(Option.some("Open"));
      const snapshot = yield* test.snapshot;
      Vitest.expect(snapshot.informationMessages).toEqual(["Saved"]);
      Vitest.expect(snapshot.warningMessages).toEqual(["Missing notebook"]);
      Vitest.expect(snapshot.errorMessages).toEqual(["Save failed"]);
    }),
  );

  it.effect(
    "publishes configuration changes",
    Effect.fn(function* () {
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      const received = yield* code.workspace.configurationChanges.pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );
      const event: vscode.ConfigurationChangeEvent = {
        affectsConfiguration: (section) => section === "marimo.telemetry",
      };

      yield* test.configurationChange(event);

      Vitest.expect(yield* Fiber.join(received)).toEqual(Option.some(event));
    }),
  );

  it.effect(
    "subscribes before emitting the active notebook editor snapshot",
    Effect.fn(function* () {
      const initial = VsCodeTest.makeNotebookEditor("/test/initial_mo.py");
      const next = VsCodeTest.makeNotebookEditor("/test/next_mo.py");
      const initialObserved = yield* Deferred.make<void>();
      let listener:
        | ((editor: vscode.NotebookEditor | undefined) => unknown)
        | undefined;
      let disposals = 0;
      const changes = makeActiveNotebookEditorChanges({
        get activeNotebookEditor() {
          Vitest.expect(listener).toBeDefined();
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
      Vitest.expect(editors).toEqual([
        Option.some("file:///test/initial_mo.py"),
        Option.some("file:///test/next_mo.py"),
      ]);
      Vitest.expect(disposals).toBe(1);
    }),
  );

  it.effect(
    "keeps notebook lifecycle events and the document snapshot consistent",
    Effect.fn(function* () {
      const editor = VsCodeTest.makeNotebookEditor("/test/foo_mo.py");
      const vscode = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;

      // Open before subscribing: the document must still appear in the
      // lifecycle snapshot instead of being lost between independent stores.
      yield* vscode.openNotebook(editor.notebook);
      const lifecycle = yield* code.workspace.subscribeNotebookLifecycle;
      const opened = yield* Stream.runHead(lifecycle);
      Vitest.expect(Option.map(opened, (event) => event.type)).toEqual(
        Option.some("opened"),
      );
      Vitest.expect(yield* code.workspace.getNotebookDocuments).toContain(
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
      Vitest.expect(Option.map(closed, (event) => event.document)).toEqual(
        Option.some(editor.notebook),
      );
      Vitest.expect(yield* code.workspace.getNotebookDocuments).not.toContain(
        editor.notebook,
      );
    }),
  );

  it.effect(
    "disposes notebook lifecycle listeners when its consumer ends",
    Effect.fn(function* () {
      const editor = VsCodeTest.makeNotebookEditor("/test/notebook_mo.py");
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

      Vitest.expect(disposals).toBe(2);
      Vitest.expect(opened).toBeUndefined();
      Vitest.expect(closed).toBeUndefined();
    }),
  );

  it.effect(
    "supports setting notebook editor",
    Effect.fn(function* () {
      const editor = VsCodeTest.makeNotebookEditor("/test/foo_mo.py");
      const vscode = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;

      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.setActiveNotebookEditor(Option.some(editor));
      const activeEditor = yield* code.window.getActiveNotebookEditor;

      Vitest.assert(activeEditor._tag === "Some");
      Vitest.expect(editor).toBe(activeEditor.value);
    }),
  );

  it.effect(
    "keeps active and visible notebook state consistent across repeated activation and close",
    Effect.fn(function* () {
      const editor = VsCodeTest.makeNotebookEditor("/test/active.py");
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      yield* test.openNotebook(editor.notebook);
      yield* test.setActiveNotebookEditor(Option.some(editor));
      yield* test.setActiveNotebookEditor(Option.some(editor));
      Vitest.expect(yield* code.window.getVisibleNotebookEditors).toEqual([
        editor,
      ]);

      const lifecycle = yield* code.workspace.subscribeNotebookLifecycle;
      const closed = yield* lifecycle.pipe(
        Stream.filter((event) => event.type === "closed"),
        Stream.mapEffect(() => test.snapshot),
        Stream.runHead,
        Effect.forkChild,
      );
      yield* test.closeNotebook(editor.notebook);
      const snapshot = Option.getOrThrow(yield* Fiber.join(closed));
      Vitest.expect(snapshot.activeNotebookUri).toEqual(Option.none());
      Vitest.expect(snapshot.visibleNotebookUris).toEqual([]);
      Vitest.expect(snapshot.openNotebookUris).toEqual([]);
      Vitest.expect(editor.notebook.isClosed).toBe(true);
    }),
  );

  it.effect(
    "keeps the replacement editor active when an old document closes at the same URI",
    Effect.fn(function* () {
      const old = VsCodeTest.makeNotebookEditor("/test/reopened.py");
      const replacement = VsCodeTest.makeNotebookEditor("/test/reopened.py");
      const test = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;
      yield* test.openNotebook(old.notebook);
      yield* test.setActiveNotebookEditor(Option.some(old));
      yield* test.openNotebook(replacement.notebook);
      yield* test.setActiveNotebookEditor(Option.some(replacement));
      yield* test.closeNotebook(old.notebook);

      Vitest.expect(yield* code.window.getActiveNotebookEditor).toEqual(
        Option.some(replacement),
      );
      Vitest.expect(yield* code.window.getVisibleNotebookEditors).toEqual([
        replacement,
      ]);
      Vitest.expect(yield* code.workspace.getNotebookDocuments).toEqual([
        replacement.notebook,
      ]);
      Vitest.expect(replacement.notebook.isClosed).toBe(false);
    }),
  );

  it.effect(
    "should emit changes to active editor stream",
    Effect.fn(function* () {
      const editors = [
        VsCodeTest.makeNotebookEditor("/test/foo_mo1.py"),
        VsCodeTest.makeNotebookEditor("/test/foo_mo2.py"),
        VsCodeTest.makeNotebookEditor("/test/foo_mo3.py"),
      ];
      const vscode = yield* VsCodeTest.Service;
      const code = yield* VsCode.Service;

      yield* Effect.forEach(editors, (editor) =>
        vscode.openNotebook(editor.notebook),
      );

      // `SubscriptionRef.changes` sends the current value at
      // subscription. Expect the first None and the five updates below.
      const subscriptionReady = yield* Deferred.make<void>();
      const fiber = yield* code.window.activeNotebookEditorChanges.pipe(
        Stream.tap(() => Deferred.succeed(subscriptionReady, undefined)),
        Stream.take(6),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscriptionReady);

      yield* vscode.setActiveNotebookEditor(Option.some(editors[0]));

      yield* vscode.setActiveNotebookEditor(Option.some(editors[1]));

      yield* vscode.setActiveNotebookEditor(Option.some(editors[2]));

      yield* vscode.setActiveNotebookEditor(Option.some(editors[2]));

      yield* vscode.setActiveNotebookEditor(Option.none());

      const collected = yield* Fiber.join(fiber);
      const result = collected.map(
        Option.map((notebookEditor) => notebookEditor.notebook.uri.toString()),
      );

      Vitest.expect(result.map(Option.getOrNull)).toMatchInlineSnapshot(`
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
