import * as Vitest from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Scope } from "effect";

import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { marimoConfigFixture } from "../../lib/__tests__/branded.ts";
import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import * as NotebookSerializer from "../../notebook/NotebookSerializer.ts";
import * as NotebookSessionResources from "../../notebook/NotebookSessionResources.ts";
import * as Constants from "../../platform/Constants.ts";
import * as GitHubClient from "../../platform/GitHubClient.ts";
import * as OutputChannel from "../../platform/OutputChannel.ts";
import {
  MarimoNotebookDocument,
  MarimoNotebookCell,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { NotebookTarget } from "../Invocation.ts";
import showNotebookMenu, { NOTEBOOK_MENU_ITEMS } from "../showNotebookMenu.ts";

const constantsLayer = Layer.succeed(
  Constants.Service,
  Constants.Service.of({
    LanguageId: {
      Python: "mo-python",
      Sql: "sql",
      Markdown: "markdown",
    },
  }),
);

const runtimeLayer = makeTestNotebookRuntime({
  send: (request) =>
    request.kind === "get-configuration"
      ? Effect.succeed({
          config: marimoConfigFixture({
            runtime: {
              on_cell_change: "lazy",
              auto_reload: "autorun",
            },
          }),
        })
      : Effect.die("not implemented"),
});

const serializerLayer = Layer.mock(NotebookSerializer.Service, {
  notebookType: NOTEBOOK_TYPE,
});

const githubLayer = Layer.succeed(
  GitHubClient.Service,
  GitHubClient.Service.of({
    Gists: {
      create: () => Effect.die("not implemented"),
      update: () => Effect.die("not implemented"),
    },
  }),
);

const targetFor = (
  editor: ReturnType<typeof TestVsCode.makeNotebookEditor>,
): Option.Option<NotebookTarget> =>
  Option.map(MarimoNotebookDocument.tryFrom(editor.notebook), (document) => ({
    document,
    editor,
  }));

const layerWith = (
  runtime: ReturnType<typeof makeTestNotebookRuntime> = runtimeLayer,
) => {
  const documentSessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(TestVsCode.layer),
  );
  const sessionResources = NotebookSessionResources.layer.pipe(
    Layer.provide(documentSessions),
    Layer.provide(runtime),
  );
  return Layer.mergeAll(
    TestVsCode.layer,
    documentSessions,
    sessionResources,
    constantsLayer,
    runtime,
    serializerLayer,
    githubLayer,
    OutputChannel.layer.pipe(Layer.provide(TestVsCode.layer)),
  );
};

const it = EffectTest.make(layerWith());
const menuLabel = (value: (typeof NOTEBOOK_MENU_ITEMS)[number]["value"]) =>
  Option.getOrThrow(
    Option.fromNullishOr(
      NOTEBOOK_MENU_ITEMS.find((item) => item.value === value)?.label,
    ),
  );

Vitest.describe("showNotebookMenu", () => {
  it.effect(
    "offers a focused four-item notebook menu",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      yield* showNotebookMenu.invoke(Option.none());

      const snapshot = yield* vscode.snapshot;
      Vitest.expect(
        snapshot.quickPicks[0]?.items.map((item) => item.label),
      ).toEqual(NOTEBOOK_MENU_ITEMS.map((item) => item.label));
      Vitest.expect(snapshot.executions).toEqual([]);
    }),
  );

  it.effect(
    "creates a setup cell in the normalized target notebook",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.selectQuickPick(menuLabel("create-setup-cell"));
      yield* showNotebookMenu.invoke(targetFor(editor));

      const snapshot = yield* vscode.snapshot;
      Vitest.expect(snapshot.workspaceEdits).toHaveLength(1);
      Vitest.expect(snapshot.executions).toEqual([]);
    }),
  );

  it.effect(
    "routes publish through the normalized target",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      yield* vscode.selectQuickPick(menuLabel("publish-notebook"));
      yield* showNotebookMenu.invoke(Option.none());

      const snapshot = yield* vscode.snapshot;
      Vitest.expect(snapshot.warningMessages).toEqual([
        "Must have an open marimo notebook to publish Gist.",
      ]);
      Vitest.expect(snapshot.executions).toEqual([]);
    }),
  );

  it.effect(
    "configures exports for the normalized target notebook",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
        data: {
          metadata: MarimoNotebookDocument.createMetadata({
            appOptions: { managed: { autoDownload: [] }, passthrough: {} },
          }),
          cells: [
            {
              kind: 2,
              value: "1 + 1",
              languageId: "python",
              metadata: MarimoNotebookCell.createMetadata({
                marimoRuntime: { stableId: "cell-1" },
              }),
            },
          ],
        },
      });
      yield* vscode.openNotebook(editor.notebook);
      yield* vscode.selectQuickPick(menuLabel("automatic-exports"));
      yield* vscode.selectQuickPickMany(["HTML"]);
      yield* showNotebookMenu.invoke(targetFor(editor));

      Vitest.expect((yield* vscode.snapshot).workspaceEdits).toHaveLength(1);
    }),
  );

  it.effect(
    "shows the current reactivity state for the normalized target",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.Service;
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      yield* vscode.openNotebook(editor.notebook);
      yield* Effect.yieldNow;
      yield* vscode.selectQuickPick(menuLabel("reactivity"));
      yield* showNotebookMenu.invoke(targetFor(editor));

      const snapshot = yield* vscode.snapshot;
      Vitest.expect(
        snapshot.quickPicks[1]?.items.flatMap((item) => item.description ?? []),
      ).toEqual(["Lazy", "Auto-run"]);
    }),
  );

  Vitest.it.effect(
    "ends quietly if the notebook closes while loading reactivity",
    Effect.fn(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      const runtime = makeTestNotebookRuntime({
        send: (request) =>
          request.kind === "get-configuration"
            ? Deferred.succeed(requestStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseRequest)),
                Effect.andThen(
                  Effect.succeed({
                    config: marimoConfigFixture({}),
                  }),
                ),
              )
            : Effect.die("not implemented"),
      });

      yield* Effect.gen(function* () {
        const vscode = yield* TestVsCode.Service;
        yield* vscode.openNotebook(editor.notebook);
        yield* Effect.yieldNow;
        yield* vscode.selectQuickPick(menuLabel("reactivity"));
        const sessions = yield* NotebookDocumentSessions.Service;
        const session = Option.getOrThrow(
          sessions.forDocument(editor.notebook),
        );
        const sessionEnded = yield* Deferred.make<void>();

        const running = yield* showNotebookMenu
          .invoke(targetFor(editor))
          .pipe(Effect.forkChild);
        yield* Deferred.await(requestStarted);
        yield* Scope.addFinalizer(
          session.scope,
          Deferred.succeed(sessionEnded, undefined),
        );
        const closing = yield* vscode
          .closeNotebook(editor.notebook)
          .pipe(Effect.forkChild);
        yield* Deferred.await(sessionEnded);
        yield* Deferred.succeed(releaseRequest, undefined);

        yield* Fiber.join(closing);
        yield* Fiber.join(running);
      }).pipe(Effect.provide(layerWith(runtime)));
    }),
  );
});
