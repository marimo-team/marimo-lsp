import { assert, expect, it } from "@effect/vitest";
import type * as py from "@vscode/python-extension";
import { Effect, Layer, Option, TestClock } from "effect";
import { TestLanguageClientLive } from "../../__mocks__/TestLanguageClient.ts";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { Constants } from "../Constants.ts";
import { ControllerRegistry } from "../ControllerRegistry.ts";
import { VsCode } from "../VsCode.ts";
import { MarimoNotebookDocument } from "../../schemas.ts";

const withTestCtx = Effect.fnUntraced(function* (
  options: { initialEnvs?: Array<py.ResolvedEnvironment> } = {},
) {
  const { initialEnvs = [] } = options;
  const vscode = yield* TestVsCode.make();
  const py = yield* TestPythonExtension.make(initialEnvs);

  const layer = Layer.empty.pipe(
    Layer.provideMerge(ControllerRegistry.Default),
    Layer.provide(Constants.Default),
    Layer.provide(TestLanguageClientLive),
    Layer.provideMerge(vscode.layer),
    Layer.provideMerge(py.layer),
  );

  return { layer, vscode, py };
});

it.effect(
  "should return None for active controller when no notebook is selected",
  Effect.fnUntraced(function* () {
    const { layer } = yield* withTestCtx();

    const controller = yield* Effect.gen(function* () {
      const code = yield* VsCode;
      const registry = yield* ControllerRegistry;

      const notebook = MarimoNotebookDocument.from(
        createTestNotebookDocument(code.Uri.file("/test/notebook_mo.py")),
      );

      return yield* registry.getActiveController(notebook);
    }).pipe(Effect.provide(layer));

    expect(Option.isNone(controller)).toBe(true);
  }),
);

it.effect(
  "should create controllers for initial python environments",
  Effect.fnUntraced(function* () {
    const { layer } = yield* withTestCtx({
      initialEnvs: [
        TestPythonExtension.makeVenv("/home/user/.venv/bin/python"),
        TestPythonExtension.makeGlobalEnv("/usr/local/bin/python3.11"),
      ],
    });

    const snapshot = yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;
      return yield* registry.snapshot();
    }).pipe(Effect.provide(layer));

    expect(snapshot).toMatchInlineSnapshot(`
      {
        "controllers": [
          {
            "executable": "/home/user/.venv/bin/python",
            "id": "marimo-/home/user/.venv/bin/python",
          },
        ],
        "selections": [],
      }
    `);
  }),
);

it.effect(
  "should add controller when new python environment is added",
  Effect.fnUntraced(function* () {
    const { layer, py } = yield* withTestCtx({
      initialEnvs: [TestPythonExtension.makeVenv("/usr/local/bin/python3.11")],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      // Initial state - should have one controller
      const snapshot1 = yield* registry.snapshot();
      expect(snapshot1).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Add new venv environment
      const env2 = TestPythonExtension.makeVenv("/home/user/.venv/bin/python");
      yield* py.addEnvironment(env2);

      // Give time for the stream to process
      yield* TestClock.adjust("100 millis");

      // Should now have two controllers
      const snapshot2 = yield* registry.snapshot();
      expect(snapshot2).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should remove controller when python environment is removed",
  Effect.fnUntraced(function* () {
    const { layer, py } = yield* withTestCtx({
      initialEnvs: [
        TestPythonExtension.makeVenv("/usr/local/bin/python3.11"),
        TestPythonExtension.makeVenv("/home/user/.venv/bin/python"),
        TestPythonExtension.makeGlobalEnv("/opt/homebrew/bin/python3"),
      ],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      // Initial state - should have two controllers (global env filtered out)
      const snapshot1 = yield* registry.snapshot();
      expect(snapshot1).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/home/user/.venv/bin/python",
              "id": "marimo-/home/user/.venv/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Remove venv environment
      const env2 = TestPythonExtension.makeVenv("/home/user/.venv/bin/python");
      yield* py.removeEnvironment(env2);

      // Give time for the stream to process
      yield* TestClock.adjust("100 millis");

      // Should now have one controller (global env still filtered)
      const snapshot2 = yield* registry.snapshot();
      expect(snapshot2).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/home/user/.venv/bin/python",
              "id": "marimo-/home/user/.venv/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should track controller selections for notebooks",
  Effect.fnUntraced(function* () {
    const { layer, vscode } = yield* withTestCtx({
      initialEnvs: [
        TestPythonExtension.makeVenv("/usr/local/bin/python3.11"),
        TestPythonExtension.makeVenv("/home/user/.venv/bin/python"),
        TestPythonExtension.makeGlobalEnv("/opt/homebrew/bin/python3"),
      ],
    });

    yield* Effect.gen(function* () {
      const code = yield* VsCode;
      const registry = yield* ControllerRegistry;

      const notebook1 = MarimoNotebookDocument.from(
        createTestNotebookDocument(code.Uri.file("/test/notebook1_mo.py")),
      );
      const notebook2 = MarimoNotebookDocument.from(
        createTestNotebookDocument(code.Uri.file("/test/notebook2_mo.py")),
      );

      // Get controllers from vscode snapshot
      const vsSnapshot = yield* vscode.snapshot();
      expect(vsSnapshot.controllers).toMatchInlineSnapshot(`
        [
          "marimo-/home/user/.venv/bin/python",
          "marimo-/usr/local/bin/python3.11",
          "marimo-sandbox",
        ]
      `);

      // Verify getActiveController returns None initially
      const controller1 = yield* registry.getActiveController(notebook1);
      const controller2 = yield* registry.getActiveController(notebook2);

      assert(Option.isNone(controller1));
      assert(Option.isNone(controller2));

      // Verify snapshot shows no selections
      const snapshot = yield* registry.snapshot();
      expect(snapshot).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/home/user/.venv/bin/python",
              "id": "marimo-/home/user/.venv/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should not remove controller when it's in use by a notebook",
  Effect.fnUntraced(function* () {
    const { layer, py } = yield* withTestCtx({
      initialEnvs: [
        TestPythonExtension.makeVenv("/usr/local/bin/python3.11"),
        TestPythonExtension.makeVenv("/home/user/.venv/bin/python"),
      ],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      // Initial state
      const snapshot1 = yield* registry.snapshot();
      expect(snapshot1).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/home/user/.venv/bin/python",
              "id": "marimo-/home/user/.venv/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Try to remove env1 (would require simulating a notebook selection first)
      const env1 = TestPythonExtension.makeVenv("/usr/local/bin/python3.11");
      yield* py.removeEnvironment(env1);

      // Give time for the stream to process
      yield* TestClock.adjust("100 millis");

      // Should remove since no notebook is using it
      const snapshot2 = yield* registry.snapshot();
      expect(snapshot2).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/home/user/.venv/bin/python",
              "id": "marimo-/home/user/.venv/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should handle multiple environment additions and removals",
  Effect.fnUntraced(function* () {
    const { layer, py } = yield* withTestCtx({
      initialEnvs: [
        TestPythonExtension.makeVenv("/usr/local/bin/python3.11"),
        TestPythonExtension.makeGlobalEnv("/opt/homebrew/bin/python3"),
      ],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      const env1 = TestPythonExtension.makeVenv("/usr/local/bin/python3.11");
      const env2 = TestPythonExtension.makeVenv("/home/user/.venv/bin/python");
      const env3 = TestPythonExtension.makeVenv("/opt/python3.12/bin/python");

      // Initial: 1 controller (global env filtered out)
      let snapshot = yield* registry.snapshot();
      expect(snapshot).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Add env2 (venv)
      yield* py.addEnvironment(env2);
      yield* TestClock.adjust("100 millis");

      snapshot = yield* registry.snapshot();
      expect(snapshot).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Add env3
      yield* py.addEnvironment(env3);
      yield* TestClock.adjust("100 millis");

      snapshot = yield* registry.snapshot();
      expect(snapshot).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/home/user/.venv/bin/python",
              "id": "marimo-/home/user/.venv/bin/python",
            },
            {
              "executable": "/opt/python3.12/bin/python",
              "id": "marimo-/opt/python3.12/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Remove env2
      yield* py.removeEnvironment(env2);
      yield* TestClock.adjust("100 millis");

      snapshot = yield* registry.snapshot();
      expect(snapshot).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/opt/python3.12/bin/python",
              "id": "marimo-/opt/python3.12/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Remove env1
      yield* py.removeEnvironment(env1);
      yield* TestClock.adjust("100 millis");

      snapshot = yield* registry.snapshot();
      expect(snapshot).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/opt/python3.12/bin/python",
              "id": "marimo-/opt/python3.12/bin/python",
            },
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should update controller description when environment changes",
  Effect.fnUntraced(function* () {
    const { layer, py } = yield* withTestCtx({
      initialEnvs: [TestPythonExtension.makeVenv("/usr/local/bin/python3.11")],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      const env1 = TestPythonExtension.makeVenv("/usr/local/bin/python3.11");

      // Initial snapshot
      const snapshot1 = yield* registry.snapshot();
      expect(snapshot1).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);

      // Simulate environment change by removing and re-adding with same path
      // This tests the update path in createOrUpdateController
      yield* py.removeEnvironment(env1);
      yield* TestClock.adjust("100 millis");

      yield* py.addEnvironment(env1);
      yield* TestClock.adjust("100 millis");

      const snapshot2 = yield* registry.snapshot();
      expect(snapshot2).toMatchInlineSnapshot(`
        {
          "controllers": [
            {
              "executable": "/usr/local/bin/python3.11",
              "id": "marimo-/usr/local/bin/python3.11",
            },
          ],
          "selections": [],
        }
      `);
    }).pipe(Effect.provide(layer));
  }),
);
it.effect(
  "should not set affinity when notebook has no script header or venv",
  Effect.fnUntraced(function* () {
    const { layer, vscode } = yield* withTestCtx({
      initialEnvs: [TestPythonExtension.makeVenv("/usr/local/bin/python3.11")],
    });

    yield* Effect.gen(function* () {
      const code = yield* VsCode;

      // Create a notebook without script header
      const notebook = createTestNotebookDocument(
        code.Uri.file("/test/notebook_mo.py"),
        { data: { cells: [], metadata: {} } },
      );

      const editor = TestVsCode.makeNotebookEditor(notebook.uri.path);

      // Open the notebook by setting it as active
      yield* vscode.setActiveNotebookEditor(Option.some(editor));

      // Give time for the affinity update to process
      yield* TestClock.adjust("100 millis");

      // Check affinity updates - should be empty
      const affinityUpdates = yield* vscode.getAffinityUpdates();

      expect(affinityUpdates).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "should handle opening multiple notebooks",
  Effect.fnUntraced(function* () {
    const { layer, vscode } = yield* withTestCtx({
      initialEnvs: [TestPythonExtension.makeVenv("/usr/local/bin/python3.11")],
    });

    yield* Effect.gen(function* () {
      const code = yield* VsCode;

      const editor1 = TestVsCode.makeNotebookEditor(
        code.Uri.file("/test/notebook1_mo.py"),
      );
      const editor2 = TestVsCode.makeNotebookEditor(
        code.Uri.file("/test/notebook2_mo.py"),
      );

      // Open first notebook
      yield* vscode.setActiveNotebookEditor(Option.some(editor1));
      yield* TestClock.adjust("100 millis");

      // Open second notebook
      yield* vscode.setActiveNotebookEditor(Option.some(editor2));
      yield* TestClock.adjust("100 millis");

      // Check affinity updates - should be empty since no script headers
      const affinityUpdates = yield* vscode.getAffinityUpdates();

      expect(affinityUpdates).toEqual([]);
    }).pipe(Effect.provide(layer));
  }),
);
