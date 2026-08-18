import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream } from "effect";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { MarimoLspServer } from "../../config/Config.ts";
import { NOTEBOOK_TYPE } from "../../constants.ts";
import { marimoConfigFixture } from "../../lib/__tests__/branded.ts";
import { makeMarimoCommands, MarimoClient } from "../../lsp/MarimoClient.ts";
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

const marimoLayer = Layer.succeed(
  MarimoClient,
  MarimoClient.of({
    server: MarimoLspServer.Python(),
    channel: { name: "marimo-lsp-test", show() {} },
    restart: Effect.void,
    ...makeMarimoCommands({
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
      kernelNotifications: Stream.empty,
    }),
  }),
);

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

const testLayer = (vscode: TestVsCode) => {
  const documentSessions = NotebookDocumentSessions.layer.pipe(
    Layer.provide(vscode.layer),
  );
  const sessionResources = NotebookSessionResources.layer.pipe(
    Layer.provide(documentSessions),
    Layer.provide(marimoLayer),
  );
  return Layer.mergeAll(
    vscode.layer,
    documentSessions,
    sessionResources,
    constantsLayer,
    marimoLayer,
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
});
