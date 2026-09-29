import * as Vitest from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Scope, Stream } from "effect";

import type { NotebookTarget } from "../../src/commands/Invocation.ts";
import showNotebookMenu, {
  NOTEBOOK_MENU_ITEMS,
} from "../../src/commands/showNotebookMenu.ts";
import { NOTEBOOK_TYPE } from "../../src/constants.ts";
import * as NotebookDocumentSessions from "../../src/notebook/NotebookDocumentSessions.ts";
import * as NotebookSerializer from "../../src/notebook/NotebookSerializer.ts";
import * as NotebookSessionResources from "../../src/notebook/NotebookSessionResources.ts";
import * as Constants from "../../src/platform/Constants.ts";
import * as GitHubClient from "../../src/platform/GitHubClient.ts";
import * as OutputChannel from "../../src/platform/OutputChannel.ts";
import {
  MarimoNotebookDocument,
  MarimoNotebookCell,
} from "../../src/schemas/MarimoNotebookDocument.ts";
import * as NotebookRuntimeTest from "../fake/NotebookRuntime.ts";
import * as VsCodeTest from "../fake/VsCode.ts";
import { marimoConfigFixture } from "../lib/branded.ts";
import * as EffectTest from "../lib/EffectTest.ts";

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

const runtimeLayer = NotebookRuntimeTest.layerWith({
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
  editor: ReturnType<typeof VsCodeTest.makeNotebookEditor>,
): Option.Option<NotebookTarget> =>
  Option.map(MarimoNotebookDocument.tryFrom(editor.notebook), (document) => ({
    document,
    editor,
  }));

const layerWith = (
  runtime: ReturnType<typeof NotebookRuntimeTest.layerWith> = runtimeLayer,
) => {
  const documentSessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(VsCodeTest.layer),
  );
  const sessionResources = NotebookSessionResources.layer.pipe(
    Layer.provide(documentSessions),
    Layer.provide(runtime),
  );
  return Layer.mergeAll(
    VsCodeTest.layer,
    documentSessions,
    sessionResources,
    constantsLayer,
    runtime,
    serializerLayer,
    githubLayer,
    OutputChannel.layer.pipe(Layer.provide(VsCodeTest.layer)),
  );
};

const it = EffectTest.make(layerWith());
const menuLabel = (value: (typeof NOTEBOOK_MENU_ITEMS)[number]["value"]) =>
  Option.getOrThrow(
    Option.fromNullishOr(
      NOTEBOOK_MENU_ITEMS.find((item) => item.value === value)?.label,
    ),
  );

const openSession = Effect.fn(function* (
  vscode: VsCodeTest.Interface,
  editor: ReturnType<typeof VsCodeTest.makeNotebookEditor>,
) {
  yield* vscode.openNotebook(editor.notebook);
  yield* vscode.setActiveNotebookEditor(Option.some(editor));
  const sessions = yield* NotebookDocumentSessions.Service;
  return yield* sessions.active.pipe(
    Stream.filter(
      Option.exists((session) => session.document === editor.notebook),
    ),
    Stream.runHead,
    Effect.map((active) => Option.getOrThrow(Option.flatten(active))),
  );
});

Vitest.describe("showNotebookMenu", () => {
  it.effect(
    "offers a focused four-item notebook menu",
    Effect.fn(function* () {
      const vscode = yield* VsCodeTest.Service;
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
      const vscode = yield* VsCodeTest.Service;
      const editor = VsCodeTest.makeNotebookEditor("/test/notebook.py");
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
      const vscode = yield* VsCodeTest.Service;
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
      const vscode = yield* VsCodeTest.Service;
      const editor = VsCodeTest.makeNotebookEditor("/test/report.py", {
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
      const vscode = yield* VsCodeTest.Service;
      const editor = VsCodeTest.makeNotebookEditor("/test/notebook.py");
      yield* openSession(vscode, editor);
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
      const editor = VsCodeTest.makeNotebookEditor("/test/notebook.py");
      const runtime = NotebookRuntimeTest.layerWith({
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
        const vscode = yield* VsCodeTest.Service;
        const session = yield* openSession(vscode, editor);
        yield* vscode.selectQuickPick(menuLabel("reactivity"));
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
