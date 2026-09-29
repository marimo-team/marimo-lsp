import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Latch, Schema } from "effect";

import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as TestNotebookDependencies from "./TestNotebookDependencies.ts";

Vitest.describe("NotebookDependencies", () => {
  const it = EffectTest.make(TestNotebookDependencies.layer);

  it.effect(
    "loads through the controller owned by its notebook session",
    Effect.fn(function* () {
      const dependencies = yield* TestNotebookDependencies.Service;
      const states = yield* dependencies.collect({
        notebookId: TestNotebookDependencies.OTHER_NOTEBOOK_URI,
      });

      Vitest.expect(states.at(-1)).toEqual({
        _tag: "Loaded",
        tree: TestNotebookDependencies.TREE,
      });
      Vitest.expect(yield* dependencies.requests).toEqual([
        {
          kind: "get-dependency-tree",
          notebookUri: TestNotebookDependencies.OTHER_NOTEBOOK_URI,
          source: {
            kind: "venv",
            executable: "/other/.venv/bin/python",
          },
        },
      ]);
    }),
  );

  Vitest.describe("with a shared load", () => {
    const it = EffectTest.make(
      TestNotebookDependencies.layerWith(
        TestNotebookDependencies.Scenario.SharedLoad(),
      ),
    );

    it.effect(
      "shares one in-flight load between changes subscribers",
      Effect.fn(function* () {
        const dependencies = yield* TestNotebookDependencies.Service;
        const firstSubscribed = yield* Latch.make();
        const secondSubscribed = yield* Latch.make();
        const subscribers = yield* Effect.all(
          [
            dependencies.collect({ onState: firstSubscribed.open }),
            dependencies.collect({ onState: secondSubscribed.open }),
          ],
          { concurrency: "unbounded" },
        ).pipe(Effect.forkChild);
        yield* firstSubscribed.await;
        yield* secondSubscribed.await;
        yield* dependencies.requestStarted;

        Vitest.expect(yield* dependencies.requests).toHaveLength(1);
        yield* dependencies.releaseRequest;
        const results = yield* Fiber.join(subscribers);
        Vitest.expect(results[0]?.at(-1)).toEqual({
          _tag: "Loaded",
          tree: TestNotebookDependencies.TREE,
        });
        Vitest.expect(results[1]?.at(-1)).toEqual({
          _tag: "Loaded",
          tree: TestNotebookDependencies.TREE,
        });
      }),
    );
  });

  Vitest.describe("with a Python environment", () => {
    const it = EffectTest.make(
      TestNotebookDependencies.layerWith(
        TestNotebookDependencies.Scenario.PythonFallback(),
      ),
    );

    it.effect(
      "falls back to the flat package list for a Python environment",
      Effect.fn(function* () {
        const dependencies = yield* TestNotebookDependencies.Service;
        const states = yield* dependencies.collect();

        Vitest.expect(states.at(-1)).toEqual({
          _tag: "Loaded",
          tree: {
            name: "installed-packages",
            version: null,
            tags: [],
            dependencies: [
              {
                name: "effect",
                version: "4.0.0",
                tags: [],
                dependencies: [],
              },
            ],
          },
        });
        Vitest.expect(
          (yield* dependencies.requests).map((request) => request.kind),
        ).toEqual(["get-dependency-tree", "list-packages"]);
      }),
    );
  });

  Vitest.describe("with a script failure", () => {
    const it = EffectTest.make(
      TestNotebookDependencies.layerWith(
        TestNotebookDependencies.Scenario.ScriptFailure(),
      ),
    );

    it.effect(
      "preserves script-mode failures without using the venv fallback",
      Effect.fn(function* () {
        const dependencies = yield* TestNotebookDependencies.Service;
        const failure = Schema.decodeUnknownEffect(Schema.Number)("invalid");
        const expectedError = String(yield* Effect.flip(failure));
        const states = yield* dependencies.collect();

        Vitest.expect(states.at(-1)).toEqual({
          _tag: "Failed",
          error: expectedError,
        });
        Vitest.expect(
          (yield* dependencies.requests).map((request) => request.kind),
        ).toEqual(["get-dependency-tree"]);
      }),
    );
  });

  Vitest.describe("without a controller", () => {
    const it = EffectTest.make(
      TestNotebookDependencies.layerWith(
        TestNotebookDependencies.Scenario.MissingController(),
      ),
    );

    it.effect(
      "reports a missing controller without calling the server",
      Effect.fn(function* () {
        const dependencies = yield* TestNotebookDependencies.Service;
        const states = yield* dependencies.collect();

        Vitest.expect(states.at(-1)).toEqual({
          _tag: "Failed",
          error: "No kernel selected",
        });
        Vitest.expect(yield* dependencies.requests).toEqual([]);
      }),
    );
  });

  Vitest.describe("with a cached load", () => {
    const it = EffectTest.make(
      TestNotebookDependencies.layerWith(
        TestNotebookDependencies.Scenario.Refresh(),
      ),
    );

    it.effect(
      "refreshes a successfully cached dependency tree",
      Effect.fn(function* () {
        const dependencies = yield* TestNotebookDependencies.Service;
        const initial = yield* dependencies.collect();
        Vitest.expect(initial.at(-1)).toEqual({
          _tag: "Loaded",
          tree: { ...TestNotebookDependencies.TREE, name: "first" },
        });

        Vitest.expect(yield* dependencies.current()).toEqual({
          _tag: "Loaded",
          tree: { ...TestNotebookDependencies.TREE, name: "first" },
        });

        yield* dependencies.refresh();
        Vitest.expect(yield* dependencies.current()).toEqual({
          _tag: "Loaded",
          tree: { ...TestNotebookDependencies.TREE, name: "refreshed" },
        });
        Vitest.expect(yield* dependencies.requests).toHaveLength(2);
      }),
    );
  });

  Vitest.describe("while a refresh is in flight", () => {
    const it = EffectTest.make(
      TestNotebookDependencies.layerWith(
        TestNotebookDependencies.Scenario.InvalidatedRefresh(),
      ),
    );

    it.effect(
      "does not publish a load invalidated by refresh",
      Effect.fn(function* () {
        const dependencies = yield* TestNotebookDependencies.Service;
        const staleRefresh = yield* dependencies
          .refresh()
          .pipe(Effect.forkChild);
        yield* dependencies.requestStarted;

        yield* dependencies.refresh();
        yield* dependencies.releaseRequest;
        yield* Fiber.join(staleRefresh);

        Vitest.expect(yield* dependencies.current()).toEqual({
          _tag: "Loaded",
          tree: { ...TestNotebookDependencies.TREE, name: "newer" },
        });
      }),
    );
  });
});
