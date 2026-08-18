import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Ref, Scope } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { marimoConfigFixture } from "../../lib/__tests__/branded.ts";
import { NotebookDocumentSessions } from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookSerializer } from "../../notebook/NotebookSerializer.ts";
import { NotebookSessionResources } from "../../notebook/NotebookSessionResources.ts";
import { Constants } from "../../platform/Constants.ts";
import { GitHubClient } from "../../platform/GitHubClient.ts";
import { OutputChannel } from "../../platform/OutputChannel.ts";
import {
  MarimoNotebookDocument,
  MarimoNotebookCell,
} from "../../schemas/MarimoNotebookDocument.ts";
import type { NotebookTarget } from "../Invocation.ts";
import showNotebookMenu, { NOTEBOOK_MENU_ITEMS } from "../showNotebookMenu.ts";

const constantsLayer = Layer.succeed(
  Constants,
  Constants.of({
    LanguageId: {
      Python: "mo-python",
      Sql: "sql",
      Markdown: "markdown",
    },
  }),
);

const runtimeLayer = makeTestNotebookRuntime({
  execute: (request) =>
    request.method === "get-configuration"
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

const serializerLayer = Layer.succeed(
  NotebookSerializer,
  NotebookSerializer.of({
    notebookType: NOTEBOOK_TYPE,
    serializeEffect: () => Effect.die("not implemented"),
    deserializeEffect: () => Effect.die("not implemented"),
  }),
);

const githubLayer = Layer.succeed(
  GitHubClient,
  GitHubClient.of({
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

const testLayer = (
  vscode: TestVsCode,
  runtime: ReturnType<typeof makeTestNotebookRuntime> = runtimeLayer,
) => {
  const documentSessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(vscode.layer),
  );
  const sessionResources = NotebookSessionResources.layer.pipe(
    Layer.provide(documentSessions),
    Layer.provide(runtime),
  );
  return Layer.mergeAll(
    vscode.layer,
    documentSessions,
    sessionResources,
    constantsLayer,
    runtime,
    serializerLayer,
    githubLayer,
    OutputChannel.layer.pipe(Layer.provide(vscode.layer)),
  );
};

describe("showNotebookMenu", () => {
  it.effect("offers a focused four-item notebook menu", () =>
    Effect.gen(function* () {
      const labels = yield* Ref.make<ReadonlyArray<string>>([]);
      const vscode = yield* TestVsCode.make({
        window: {
          showQuickPickItems: (items) =>
            Ref.set(
              labels,
              items.map((item) => item.label),
            ).pipe(Effect.as(Option.none())),
        },
      });

      yield* showNotebookMenu
        .invoke(Option.none())
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* Ref.get(labels)).toEqual(
        NOTEBOOK_MENU_ITEMS.map((item) => item.label),
      );
      expect(yield* Ref.get(vscode.executions)).toEqual([]);
    }),
  );

  it.effect("creates a setup cell in the normalized target notebook", () =>
    Effect.gen(function* () {
      const applied = yield* Ref.make(false);
      const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
        window: {
          showQuickPickItems: (items) =>
            Effect.succeed(
              Option.fromNullishOr(
                items.find((item) => item.label.includes("Create setup cell")),
              ),
            ),
        },
        workspace: {
          applyEdit: () => Ref.set(applied, true).pipe(Effect.as(true)),
        },
      });

      yield* showNotebookMenu
        .invoke(targetFor(editor))
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* Ref.get(applied)).toBe(true);
      expect(yield* Ref.get(vscode.executions)).toEqual([]);
    }),
  );

  it.effect("routes publish through the normalized target", () =>
    Effect.gen(function* () {
      const warning = yield* Ref.make(Option.none<string>());
      const vscode = yield* TestVsCode.make({
        window: {
          showQuickPickItems: (items) =>
            Effect.succeed(
              Option.fromNullishOr(
                items.find((item) => item.label.includes("Publish notebook")),
              ),
            ),
          showWarningMessage: (message) =>
            Ref.set(warning, Option.some(message)).pipe(
              Effect.as(Option.none()),
            ),
        },
      });

      yield* showNotebookMenu
        .invoke(Option.none())
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* Ref.get(warning)).toEqual(
        Option.some("Must have an open marimo notebook to publish Gist."),
      );
      expect(yield* Ref.get(vscode.executions)).toEqual([]);
    }),
  );

  it.effect("configures exports for the normalized target notebook", () =>
    Effect.gen(function* () {
      const applied = yield* Ref.make(false);
      const editor = TestVsCode.makeNotebookEditor("/test/report.py", {
        data: {
          metadata: MarimoNotebookDocument.createMetadata({
            appConfig: { auto_download: [] },
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
      const vscode = yield* TestVsCode.make({
        initialDocuments: [editor.notebook],
        window: {
          showQuickPickItems: (items) =>
            Effect.succeed(
              Option.fromNullishOr(
                items.find((item) => item.label.includes("Automatic exports")),
              ),
            ),
          showQuickPickItemsMany: (items) =>
            Effect.succeed(
              Option.some(items.filter((item) => item.label === "HTML")),
            ),
        },
        workspace: {
          applyEdit: () => Ref.set(applied, true).pipe(Effect.as(true)),
        },
      });

      yield* showNotebookMenu
        .invoke(targetFor(editor))
        .pipe(Effect.provide(testLayer(vscode)));

      expect(yield* Ref.get(applied)).toBe(true);
    }),
  );

  it.effect(
    "shows the current reactivity state for the normalized target",
    () =>
      Effect.gen(function* () {
        const descriptions = yield* Ref.make<ReadonlyArray<string>>([]);
        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
        const vscode = yield* TestVsCode.make({
          initialDocuments: [editor.notebook],
          window: {
            showQuickPickItems: (items, options) => {
              if (options?.title === "marimo notebook") {
                return Effect.succeed(
                  Option.fromNullishOr(
                    items.find((item) => item.label.includes("Reactivity")),
                  ),
                );
              }
              return Ref.set(
                descriptions,
                items.flatMap((item) => item.description ?? []),
              ).pipe(Effect.as(Option.none()));
            },
          },
        });

        yield* showNotebookMenu
          .invoke(targetFor(editor))
          .pipe(Effect.provide(testLayer(vscode)));

        expect(yield* Ref.get(descriptions)).toEqual(["Lazy", "Auto-run"]);
      }),
  );

  it.effect(
    "ends quietly if the notebook closes while loading reactivity",
    () =>
      Effect.gen(function* () {
        const requestStarted = yield* Deferred.make<void>();
        const releaseRequest = yield* Deferred.make<void>();
        const editor = TestVsCode.makeNotebookEditor("/test/notebook.py");
        const vscode = yield* TestVsCode.make({
          initialDocuments: [editor.notebook],
          window: {
            showQuickPickItems: (items) =>
              Effect.succeed(
                Option.fromNullishOr(
                  items.find((item) => item.label.includes("Reactivity")),
                ),
              ),
          },
        });
        const runtime = makeTestNotebookRuntime({
          execute: (request) =>
            request.method === "get-configuration"
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
          const sessions = yield* NotebookDocumentSessions;
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
        }).pipe(Effect.provide(testLayer(vscode, runtime)));
      }),
  );
});
