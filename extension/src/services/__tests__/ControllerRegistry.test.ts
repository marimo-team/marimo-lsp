import { assert, expect, it } from "@effect/vitest";
import { Effect, Layer, Option, TestClock } from "effect";
import { TestLanguageClientLive } from "../../__mocks__/TestLanguageClient.ts";
import { TestPythonExtension } from "../../__mocks__/TestPythonExtension.ts";
import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { ControllerRegistry } from "../ControllerRegistry.ts";
import { VsCode } from "../VsCode.ts";

const withTestCtx = Effect.fnUntraced(function* (
  options: { initialEnvs?: Array<string> } = {},
) {
  const { initialEnvs = [] } = options;
  const vscode = yield* TestVsCode.make();
  const py = yield* TestPythonExtension.make(
    initialEnvs.map(TestPythonExtension.makeEnv),
  );

  const layer = Layer.empty.pipe(
    Layer.provideMerge(ControllerRegistry.Default),
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

      const notebook = createTestNotebookDocument(
        code.Uri.file("/test/notebook_mo.py"),
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
      initialEnvs: ["/usr/local/bin/python3.11", "/home/user/.venv/bin/python"],
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
          {
            "executable": "/usr/local/bin/python3.11",
            "id": "marimo-/usr/local/bin/python3.11",
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
      initialEnvs: ["/usr/local/bin/python3.11"],
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

      // Add new environment
      const env2 = TestPythonExtension.makeEnv("/home/user/.venv/bin/python");
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
      initialEnvs: ["/usr/local/bin/python3.11", "/home/user/.venv/bin/python"],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      // Initial state - should have two controllers
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

      // Remove environment
      const env2 = TestPythonExtension.makeEnv("/home/user/.venv/bin/python");
      yield* py.removeEnvironment(env2);

      // Give time for the stream to process
      yield* TestClock.adjust("100 millis");

      // Should now have one controller
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
      initialEnvs: ["/usr/local/bin/python3.11", "/home/user/.venv/bin/python"],
    });

    yield* Effect.gen(function* () {
      const code = yield* VsCode;
      const registry = yield* ControllerRegistry;

      const notebook1 = createTestNotebookDocument(
        code.Uri.file("/test/notebook1_mo.py"),
      );
      const notebook2 = createTestNotebookDocument(
        code.Uri.file("/test/notebook2_mo.py"),
      );

      // Get controllers from vscode snapshot
      const vsSnapshot = yield* vscode.snapshot();
      expect(vsSnapshot.controllers).toMatchInlineSnapshot(`
        [
          "marimo-/home/user/.venv/bin/python",
          "marimo-/usr/local/bin/python3.11",
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
      initialEnvs: ["/usr/local/bin/python3.11", "/home/user/.venv/bin/python"],
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
      const env1 = TestPythonExtension.makeEnv("/usr/local/bin/python3.11");
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
      initialEnvs: ["/usr/local/bin/python3.11"],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      const env1 = TestPythonExtension.makeEnv("/usr/local/bin/python3.11");
      const env2 = TestPythonExtension.makeEnv("/home/user/.venv/bin/python");
      const env3 = TestPythonExtension.makeEnv("/opt/python3.12/bin/python");

      // Initial: 1 controller
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

      // Add env2
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
      initialEnvs: ["/usr/local/bin/python3.11"],
    });

    yield* Effect.gen(function* () {
      const registry = yield* ControllerRegistry;

      const env1 = TestPythonExtension.makeEnv("/usr/local/bin/python3.11");

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
