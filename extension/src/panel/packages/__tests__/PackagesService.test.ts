import { describe, expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  createTestNotebookDocument,
  createTestNotebookEditor,
  TestVsCode,
  Uri,
} from "../../../__mocks__/TestVsCode.ts";
import { makeTestNotebookRuntime } from "../../../__tests__/__utils__/TestMarimoClient.ts";
import { NOTEBOOK_TYPE } from "../../../constants.ts";
import { type NotebookController } from "../../../kernel/NotebookRuntime.ts";
import { PythonController } from "../../../kernel/PythonController.ts";
import { notebookId } from "../../../lib/__tests__/branded.ts";
import { NotebookEditorRegistry } from "../../../notebook/NotebookEditorRegistry.ts";
import { VsCode } from "../../../platform/VsCode.ts";
import { PackagesService } from "../PackagesService.ts";

const NOTEBOOK_URI = notebookId("file:///test/sandbox.py");

interface ExecutedCommand {
  readonly command: string;
  readonly params: unknown;
}

const makeContext = Effect.fn(function* (options: {
  controller: Option.Option<NotebookController>;
  treeResponse?: unknown;
  treeEffect?: Effect.Effect<unknown, Schema.SchemaError>;
}) {
  const document = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI), {
    notebookType: "marimo-notebook",
  });
  const vscode = yield* TestVsCode.make({ initialDocuments: [document] });
  const recorded: ExecutedCommand[] = [];

  const runtime = makeTestNotebookRuntime({
    // Record inside Effect.suspend so only commands that actually run are
    // captured — client effects are now built eagerly (e.g. a notebook
    // handle's `interrupt`/`close` properties) but executed lazily.
    execute: (request) =>
      Effect.suspend(() => {
        recorded.push({ command: "marimo.api", params: request });
        return (
          options.treeEffect ??
          Effect.succeed(options.treeResponse ?? { tree: null })
        );
      }),
    initialControllers: Option.match(options.controller, {
      onNone: () => [],
      onSome: (controller) => [{ notebookUri: NOTEBOOK_URI, controller }],
    }),
  });

  const editorMock = Layer.succeed(NotebookEditorRegistry, {
    getNotebookEditors: Effect.succeed([]),
    getLastNotebookEditor: () => Effect.succeed(Option.none()),
    getActiveNotebookUri: Effect.succeed(Option.some(NOTEBOOK_URI)),
    getNotebookEditor: () => Effect.succeed(Option.none()),
    getActiveNotebookEditor: Effect.succeed(
      Option.some(createTestNotebookEditor(document)),
    ),
    streamActiveNotebookChanges: Stream.empty,
  });

  const layer = Layer.empty.pipe(
    Layer.provideMerge(PackagesService.layer),
    Layer.provide(runtime),
    Layer.provide(editorMock),
    Layer.provideMerge(vscode.layer),
  );

  return { document, layer, recorded, vscode };
});

const makePythonController = Effect.fn(function* (executable: string) {
  const code = yield* VsCode;
  const controller = yield* code.notebooks.createNotebookController(
    "test-python-controller",
    NOTEBOOK_TYPE,
    "Test Python",
  );
  return new PythonController(
    controller,
    executable,
    Stream.never,
    () => () => Effect.void,
  );
});

function makeNonPythonController(): NotebookController {
  return {
    id: "test-sandbox-controller",
    drive: () => () => Effect.void,
    resolveExecutable: () => Effect.succeed("/unused"),
  };
}

describe("PackagesService", () => {
  it.effect(
    "fetchDependencyTree sends `source: script` when the active controller is sandbox",
    Effect.fn(function* () {
      const { layer, recorded } = yield* makeContext({
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
    "shares an in-flight dependency tree lookup",
    Effect.fn(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const tree = {
        name: "<root>",
        version: null,
        tags: [],
        dependencies: [],
      };
      const { layer, recorded } = yield* makeContext({
        controller: Option.some(makeNonPythonController()),
        treeEffect: Deferred.succeed(requestStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRequest)),
          Effect.as({ tree }),
        ),
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;
        const lookups = yield* Effect.forkChild(
          Effect.all(
            [
              svc.fetchDependencyTree(NOTEBOOK_URI),
              svc.fetchDependencyTree(NOTEBOOK_URI),
            ],
            { concurrency: "unbounded" },
          ),
        );
        yield* Deferred.await(requestStarted);
        yield* TestClock.adjust("1 millis");

        expect(recorded).toHaveLength(1);
        yield* Deferred.succeed(releaseRequest, undefined);
        expect(yield* Fiber.join(lookups)).toEqual([tree, tree]);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "fetchDependencyTree sends `source: venv` with the executable for a python controller",
    Effect.fn(function* () {
      const vscode = yield* TestVsCode.make();
      const controller = yield* makePythonController(
        "/home/user/.venv/bin/python",
      ).pipe(Effect.scoped, Effect.provide(vscode.layer));

      const { layer, recorded } = yield* makeContext({
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
      const { layer, recorded } = yield* makeContext({
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
    "preserves a script dependency-tree failure in package state",
    Effect.fn(function* () {
      const failure = Schema.decodeUnknownEffect(Schema.Number)("not a number");
      const error = yield* Effect.flip(failure);
      const { layer } = yield* makeContext({
        controller: Option.some(makeNonPythonController()),
        treeEffect: failure,
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;

        expect(yield* svc.fetchDependencyTree(NOTEBOOK_URI)).toBeNull();
        expect(
          Option.getOrThrow(yield* svc.getDependencyTree(NOTEBOOK_URI)),
        ).toEqual({
          tree: null,
          loading: false,
          error: String(error),
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "preserves dependency-tree and package-list failures in package state",
    Effect.fn(function* () {
      const failure = Schema.decodeUnknownEffect(Schema.Number)("not a number");
      const error = yield* Effect.flip(failure);
      const vscode = yield* TestVsCode.make();
      const controller = yield* makePythonController(
        "/home/user/.venv/bin/python",
      ).pipe(Effect.scoped, Effect.provide(vscode.layer));
      const { layer } = yield* makeContext({
        controller: Option.some(controller),
        treeEffect: failure,
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;

        expect(yield* svc.fetchDependencyTree(NOTEBOOK_URI)).toBeNull();
        expect(
          Option.getOrThrow(yield* svc.getDependencyTree(NOTEBOOK_URI)),
        ).toEqual({
          tree: null,
          loading: false,
          error: `${String(error)}; fallback also failed: ${String(error)}`,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "clearNotebook drops the cached tree so the next fetch re-issues the request",
    Effect.fn(function* () {
      const { layer, recorded } = yield* makeContext({
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
        // PackagesView performs this invalidation when the runtime reports a
        // controller change.
        yield* svc.clearNotebook(NOTEBOOK_URI);
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "invalidating bypasses the cached dependency tree",
    Effect.fn(function* () {
      let request = 0;
      const firstTree = {
        name: "<root>",
        version: null,
        tags: [],
        dependencies: [
          { name: "first", version: "1.0.0", tags: [], dependencies: [] },
        ],
      };
      const refreshedTree = {
        name: "<root>",
        version: null,
        tags: [],
        dependencies: [
          { name: "second", version: "2.0.0", tags: [], dependencies: [] },
        ],
      };
      const { layer, recorded } = yield* makeContext({
        controller: Option.some(makeNonPythonController()),
        treeEffect: Effect.sync(() => ({
          tree: request++ === 0 ? firstTree : refreshedTree,
        })),
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;

        expect(yield* svc.fetchDependencyTree(NOTEBOOK_URI)).toEqual(firstTree);
        expect(yield* svc.fetchDependencyTree(NOTEBOOK_URI)).toEqual(firstTree);
        expect(recorded).toHaveLength(1);

        yield* svc.clearNotebook(NOTEBOOK_URI);
        expect(yield* svc.fetchDependencyTree(NOTEBOOK_URI)).toEqual(
          refreshedTree,
        );
        expect(recorded).toHaveLength(2);

        const state = Option.getOrThrow(
          yield* svc.getDependencyTree(NOTEBOOK_URI),
        );
        expect(state).toEqual({
          tree: refreshedTree,
          loading: false,
          error: null,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "does not let an invalidated request overwrite a newer fetch",
    Effect.fn(function* () {
      const firstRequestStarted = yield* Deferred.make<void>();
      const releaseFirstRequest = yield* Deferred.make<void>();
      let request = 0;
      const olderTree = {
        name: "<root>",
        version: null,
        tags: [],
        dependencies: [
          { name: "older", version: "1.0.0", tags: [], dependencies: [] },
        ],
      };
      const newerTree = {
        name: "<root>",
        version: null,
        tags: [],
        dependencies: [
          { name: "newer", version: "2.0.0", tags: [], dependencies: [] },
        ],
      };
      const { layer } = yield* makeContext({
        controller: Option.some(makeNonPythonController()),
        treeEffect: Effect.suspend(() => {
          const currentRequest = request++;
          if (currentRequest === 0) {
            return Deferred.succeed(firstRequestStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseFirstRequest)),
              Effect.as({ tree: olderTree }),
            );
          }
          return Effect.succeed({ tree: newerTree });
        }),
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;
        const olderFetch = yield* Effect.forkChild(
          svc.fetchDependencyTree(NOTEBOOK_URI),
        );
        yield* Deferred.await(firstRequestStarted);

        yield* svc.clearNotebook(NOTEBOOK_URI);
        expect(yield* svc.fetchDependencyTree(NOTEBOOK_URI)).toEqual(newerTree);

        yield* Deferred.succeed(releaseFirstRequest, undefined);
        expect(yield* Fiber.join(olderFetch)).toEqual(olderTree);

        expect(
          Option.getOrThrow(yield* svc.getDependencyTree(NOTEBOOK_URI)),
        ).toEqual({
          tree: newerTree,
          loading: false,
          error: null,
        });
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "evicts the dependency tree when its notebook closes",
    Effect.fn(function* () {
      const { document, layer, recorded, vscode } = yield* makeContext({
        controller: Option.some(makeNonPythonController()),
        treeResponse: {
          tree: { name: "<root>", version: null, tags: [], dependencies: [] },
        },
      });
      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;
        yield* TestClock.adjust("1 millis");
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(1);

        yield* vscode.closeNotebook(document);
        yield* TestClock.adjust("1 millis");
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "does not restore package state from a request invalidated by close",
    Effect.fn(function* () {
      const requestStarted = yield* Deferred.make<void>();
      const releaseRequest = yield* Deferred.make<void>();
      const { document, layer, vscode } = yield* makeContext({
        controller: Option.some(makeNonPythonController()),
        treeEffect: Deferred.succeed(requestStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseRequest)),
          Effect.as({
            tree: {
              name: "<root>",
              version: null,
              tags: [],
              dependencies: [],
            },
          }),
        ),
      });
      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;
        const pending = yield* Effect.forkChild(
          svc.fetchDependencyTree(NOTEBOOK_URI),
        );
        yield* Deferred.await(requestStarted);
        yield* vscode.closeNotebook(document);
        yield* TestClock.adjust("1 millis");
        yield* Deferred.succeed(releaseRequest, undefined);
        yield* Fiber.join(pending);

        expect(Option.isNone(yield* svc.getDependencyTree(NOTEBOOK_URI))).toBe(
          true,
        );
      }).pipe(Effect.provide(layer));
    }),
  );

  it.effect(
    "ignores a delayed close from a replaced document at the same URI",
    Effect.fn(function* () {
      const { layer, recorded, vscode } = yield* makeContext({
        controller: Option.some(makeNonPythonController()),
        treeResponse: {
          tree: { name: "<root>", version: null, tags: [], dependencies: [] },
        },
      });
      const first = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI), {
        notebookType: "marimo-notebook",
      });
      const replacement = createTestNotebookDocument(Uri.parse(NOTEBOOK_URI), {
        notebookType: "marimo-notebook",
      });

      yield* Effect.gen(function* () {
        const svc = yield* PackagesService;

        yield* vscode.openNotebook(first);
        yield* TestClock.adjust("1 millis");
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(1);

        yield* vscode.openNotebook(replacement);
        yield* TestClock.adjust("1 millis");
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(2);

        yield* vscode.closeNotebook(first);
        yield* TestClock.adjust("1 millis");
        yield* svc.fetchDependencyTree(NOTEBOOK_URI);
        expect(recorded).toHaveLength(2);
      }).pipe(Effect.provide(layer));
    }),
  );
});
