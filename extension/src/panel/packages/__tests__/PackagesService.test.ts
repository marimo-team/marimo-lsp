import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
} from "../../../__mocks__/TestVsCode.ts";
import { makeTestMarimoClient } from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../../constants.ts";
import { PythonController } from "../../../kernel/NotebookControllerFactory.ts";
import {
  type NotebookController,
  NotebookControllers,
} from "../../../kernel/NotebookControllers.ts";
import { notebookId } from "../../../lib/__tests__/branded.ts";
import { NotebookEditorRegistry } from "../../../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../../../platform/VsCode.ts";
import { PackagesService } from "../PackagesService.ts";

const NOTEBOOK_URI = notebookId("file:///test/sandbox.py");

interface ExecutedCommand {
  readonly command: string;
  readonly params: unknown;
}

function makeContext(options: {
  controller: Option.Option<NotebookController>;
  treeResponse?: unknown;
}) {
  const recorded: ExecutedCommand[] = [];

  const marimoClient = makeTestMarimoClient({
    execute(request) {
      recorded.push({ command: "marimo.api", params: request });
      return Effect.succeed(options.treeResponse ?? { tree: null });
    },
  });

  const editorMock = Layer.succeed(
    NotebookEditorRegistry,
    NotebookEditorRegistry.make({
      getNotebookEditors: () => Effect.succeed([]),
      getLastNotebookEditor: () => Effect.succeed(Option.none()),
      getActiveNotebookUri: () => Effect.succeed(Option.some(NOTEBOOK_URI)),
      getNotebookEditor: () => Effect.succeed(Option.none()),
      getActiveNotebookEditor: () =>
        Effect.succeed(
          Option.some(
            createTestNotebookEditor(
              createTestNotebookDocument(NOTEBOOK_URI, {
                notebookType: "marimo-notebook",
              }),
            ),
          ),
        ),
      streamActiveNotebookChanges: () => Stream.empty,
    }),
  );

  const controllerMock = Layer.succeed(
    NotebookControllers,
    NotebookControllers.make({
      getSelected: () => Effect.succeed(options.controller),
      selectionChanges: () => Stream.empty,
      snapshot: () => Effect.succeed({ controllers: [], selections: [] }),
    }),
  );

  const layer = Layer.empty.pipe(
    Layer.provideMerge(PackagesService.Default),
    Layer.provide(marimoClient),
    Layer.provide(editorMock),
    Layer.provide(controllerMock),
  );

  return { layer, recorded };
}

const makePythonController = Effect.fn(function* (executable: string) {
  const code = yield* VsCode;
  const controller = yield* code.notebooks.createNotebookController(
    "test-python-controller",
    NOTEBOOK_TYPE,
    "Test Python",
  );
  return new PythonController(controller, executable);
});

function makeNonPythonController(): NotebookController {
  return {
    id: "test-sandbox-controller",
    createNotebookCellExecution() {
      throw new Error("Not used by PackagesService tests");
    },
    resolveExecutable: () => Effect.succeed("/unused"),
    selectedNotebookChanges: () => Stream.empty,
    updateNotebookAffinity: () => Effect.void,
  };
}

describe("PackagesService", () => {
  it.effect(
    "fetchDependencyTree sends `source: script` when the active controller is sandbox",
    Effect.fn(function* () {
      const { layer, recorded } = makeContext({
        controller: Option.some(makeNonPythonController()),
        treeResponse: {
          tree: { name: "<root>", version: null, tags: [], dependencies: [] },
        },
      });

      const tree = yield* Effect.gen(function* () {
        const svc = yield* PackagesService;
        return yield* svc.fetchDependencyTree(NOTEBOOK_URI);
      }).pipe(Effect.provide(layer));

      expect(tree).not.toBeNull();
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchInlineSnapshot(`
        {
          "command": "marimo.api",
          "params": {
            "method": "get-dependency-tree",
            "params": {
              "inner": {},
              "notebookUri": "file:///test/sandbox.py",
              "source": {
                "kind": "script",
              },
            },
          },
        }
      `);
    }),
  );

  it.effect(
    "fetchDependencyTree sends `source: venv` with the executable for a python controller",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make();
      const controller = yield* makePythonController(
        "/home/user/.venv/bin/python",
      ).pipe(Effect.scoped, Effect.provide(vscode.layer));

      const { layer, recorded } = makeContext({
        controller: Option.some(controller),
        treeResponse: {
          tree: { name: "<root>", version: null, tags: [], dependencies: [] },
        },
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
      }).pipe(Effect.provide(layer));

      expect(recorded[0]).toMatchInlineSnapshot(`
        {
          "command": "marimo.api",
          "params": {
            "method": "get-dependency-tree",
            "params": {
              "inner": {},
              "notebookUri": "file:///test/sandbox.py",
              "source": {
                "executable": "/home/user/.venv/bin/python",
                "kind": "venv",
              },
            },
          },
        }
      `);
    }),
  );

  it.effect(
    "fetchDependencyTree returns null and skips the LSP call when no controller is active",
    Effect.fn(function* () {
      const { layer, recorded } = makeContext({
        controller: Option.none(),
      });

      const tree = yield* Effect.gen(function* () {
        const svc = yield* PackagesService;
        return yield* svc.fetchDependencyTree(NOTEBOOK_URI);
      }).pipe(Effect.provide(layer));

      expect(tree).toBeNull();
      expect(recorded).toEqual([]);
    }),
  );

  it.effect(
    "clearNotebook drops the cached tree so the next fetch re-issues the request",
    Effect.fn(function* () {
      const { layer, recorded } = makeContext({
        controller: Option.some(makeNonPythonController()),
        treeResponse: {
          tree: { name: "<root>", version: null, tags: [], dependencies: [] },
        },
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;

        // First fetch — hits the LSP.
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(1);

        // Second fetch — served from cache, no new LSP call.
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(1);

        // After clearNotebook the cache is empty, so the next fetch re-issues.
        // This is the seam PackagesView relies on for controller-switch
        // invalidation (see NotebookControllers.selectionChanges).
        yield* svc.clearNotebook(NOTEBOOK_URI);
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
  );
});
