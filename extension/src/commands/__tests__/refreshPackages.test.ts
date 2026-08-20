import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
  Uri,
} from "../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../__tests__/__utils__/TestMarimoClient.ts";
import type { NotebookController } from "../../kernel/NotebookRuntime.ts";
import { notebookId } from "../../lib/__tests__/branded.ts";
import { NotebookDocumentSessions } from "../../notebook/NotebookDocumentSessions.ts";
import { NotebookEditorRegistry } from "../../notebook/NotebookEditorRegistry.ts";
import { NotebookSessionResources } from "../../notebook/NotebookSessionResources.ts";
import refreshPackages from "../refreshPackages.ts";

const NOTEBOOK_URI = notebookId("file:///test/notebook.py");

const controller: NotebookController = {
  id: "script",
  drive: () => () => Effect.void,
  resolveEnvironment: () =>
    Effect.succeed({
      executable: "/unused/python",
      marimoVersion: Option.none(),
    }),
};

it.effect("refreshes dependencies for the active document session", () =>
  Effect.gen(function* () {
    const document = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI));
    const editor = createTestNotebookEditor(document);
    const vscode = yield* TestVsCode.make({
      initialDocuments: [document],
    });
    let requests = 0;
    const runtime = makeTestNotebookRuntime({
      initialControllers: [{ notebookUri: NOTEBOOK_URI, controller }],
      execute: (request) =>
        request.method === "get-dependency-tree"
          ? Effect.sync(() => {
              requests += 1;
              return {
                tree: {
                  name: "<root>",
                  version: null,
                  tags: [],
                  dependencies: [],
                },
              };
            })
          : Effect.die(`Unexpected method: ${request.method}`),
    });
    const sessions = NotebookDocumentSessions.layer.pipe(
      Layer.provide(vscode.layer),
    );
    const resources = NotebookSessionResources.layer.pipe(
      Layer.provide(sessions),
      Layer.provide(runtime),
    );
    const editors = Layer.succeed(NotebookEditorRegistry, {
      getNotebookEditors: Effect.succeed([]),
      getLastNotebookEditor: () => Effect.succeed(Option.none()),
      getActiveNotebookUri: Effect.succeed(Option.some(NOTEBOOK_URI)),
      getNotebookEditor: () => Effect.succeed(Option.some(editor)),
      getActiveNotebookEditor: Effect.succeed(Option.some(editor)),
      streamActiveNotebookChanges: Stream.empty,
    });
    const layer = Layer.mergeAll(vscode.layer, sessions, resources, editors);

    yield* refreshPackages.invoke().pipe(Effect.provide(layer));

    expect(requests).toBe(1);
  }),
);
