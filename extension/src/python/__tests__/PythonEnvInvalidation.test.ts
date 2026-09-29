import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Layer, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as TestPythonExtension from "../../__mocks__/TestPythonExtension.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as PythonEnvInvalidation from "../PythonEnvInvalidation.ts";
import * as PythonExtension from "../PythonExtension.ts";

const it = EffectTest.make(
  PythonEnvInvalidation.layer.pipe(
    Layer.provideMerge(TestPythonExtension.layer),
  ),
);

it.effect(
  "advances the generation before publishing either invalidation source",
  () =>
    Effect.gen(function* () {
      const invalidation = yield* PythonEnvInvalidation.Service;
      const python = yield* PythonExtension.Service;
      const received = yield* invalidation.changes.pipe(
        Stream.mapEffect((reason) =>
          Effect.map(invalidation.generation, (generation) => ({
            reason,
            generation,
          })),
        ),
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild({ startImmediately: true }),
      );

      // Emit immediately after construction to cover watcher acquisition too.
      yield* python.updateActiveEnvironmentPath("/new-python");
      yield* TestClock.adjust("2 seconds");
      Vitest.expect(yield* invalidation.generation).toBe(1);

      yield* invalidation.invalidate("package-install");
      Vitest.expect(yield* Fiber.join(received)).toEqual([
        { reason: "python-env-change", generation: 1 },
        { reason: "package-install", generation: 2 },
      ]);
    }),
);
