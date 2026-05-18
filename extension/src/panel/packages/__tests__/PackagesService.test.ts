import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Stream } from "effect";

import {
  createTestNotebookEditor,
  createTestNotebookDocument,
} from "../../../__mocks__/TestVsCode.ts";
import { ControllerRegistry } from "../../../kernel/ControllerRegistry.ts";
import { notebookId } from "../../../lib/__tests__/branded.ts";
import { LanguageClient } from "../../../lsp/LanguageClient.ts";
import { NotebookEditorRegistry } from "../../../notebook/NotebookEditorRegistry.ts";
import type { PackageSource } from "../../../types.ts";
import { PackagesService } from "../PackagesService.ts";

const NOTEBOOK_URI = notebookId("file:///test/sandbox.py");

interface ExecutedCommand {
  readonly command: string;
  readonly params: unknown;
}

function makeContext(options: {
  controllerTarget: PackageSource | null;
  treeResponse?: unknown;
}) {
  const recorded: ExecutedCommand[] = [];

  const languageClient = Layer.succeed(
    LanguageClient,
    LanguageClient.make({
      channel: { name: "marimo-lsp", show() {} },
      restart: () => Effect.void,
      executeCommand(cmd) {
        recorded.push({ command: cmd.command, params: cmd.params });
        return Effect.succeed(
          options.treeResponse ?? { tree: null },
          // SAFETY: the LanguageClient interface returns `unknown`; we shape
          // it as the response the fetch path expects in this test.
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        ) as Effect.Effect<unknown>;
      },
      streamOf() {
        return Stream.never;
      },
    }),
  );

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
    ControllerRegistry,
    ControllerRegistry.make({
      getActiveController: () =>
        Effect.succeed(
          options.controllerTarget === null
            ? Option.none()
            : Option.some(
                // The packages flow only reads `target`; provide just that
                // shape to keep the test honest about the seam being exercised.
                // SAFETY: we never invoke any other method on the controller
                // during fetchDependencyTree.
                // oxlint-disable-next-line typescript/no-unsafe-type-assertion
                {
                  id: "marimo-test-controller",
                  target: options.controllerTarget,
                } as never,
              ),
        ),
      streamSelectionChanges: () => Stream.empty,
      snapshot: () => Effect.succeed({ controllers: [], selections: [] }),
    }),
  );

  const layer = Layer.empty.pipe(
    Layer.provideMerge(PackagesService.Default),
    Layer.provide(languageClient),
    Layer.provide(editorMock),
    Layer.provide(controllerMock),
  );

  return { layer, recorded };
}

describe("PackagesService", () => {
  it.effect(
    "fetchDependencyTree sends `source: script` when the active controller is sandbox",
    Effect.fn(function* () {
      const { layer, recorded } = makeContext({
        controllerTarget: { kind: "script" },
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
      const { layer, recorded } = makeContext({
        controllerTarget: {
          kind: "venv",
          executable: "/home/user/.venv/bin/python",
        },
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
      const { layer, recorded } = makeContext({ controllerTarget: null });

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
        controllerTarget: { kind: "script" },
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

        // After clearNotebook, the cache is empty and the next fetch re-issues.
        // This is the seam PackagesView relies on for controller-switch
        // invalidation (see ControllerRegistry.streamSelectionChanges).
        yield* svc.clearNotebook(NOTEBOOK_URI);
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
  );
});
