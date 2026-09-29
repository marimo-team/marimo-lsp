import * as Vitest from "@effect/vitest";
import { Effect, Fiber, Layer, Option, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as PythonEnvInvalidation from "../../src/python/PythonEnvInvalidation.ts";
import * as PythonExtension from "../../src/python/PythonExtension.ts";
import * as PythonExtensionTest from "../fake/PythonExtension.ts";
import * as EffectTest from "../lib/EffectTest.ts";

const it = EffectTest.make(
  PythonEnvInvalidation.layer.pipe(
    Layer.provideMerge(PythonExtensionTest.layer),
  ),
);

it.effect(
  "advances the generation before publishing either invalidation source",
  () =>
    Effect.gen(function* () {
      const invalidation = yield* PythonEnvInvalidation.Service;
      const python = yield* PythonExtension.Service;
      // Subscribe before each publish and read the generation after the
      // event arrives, so the pairing does not depend on scheduling.
      const nextChange = invalidation.changes.pipe(
        Stream.take(1),
        Stream.runHead,
        Effect.forkChild({ startImmediately: true }),
      );

      // Emit immediately after construction to cover watcher acquisition too.
      const first = yield* nextChange;
      yield* python.updateActiveEnvironmentPath("/new-python");
      yield* TestClock.adjust("2 seconds");
      Vitest.expect(yield* Fiber.join(first)).toEqual(
        Option.some("python-env-change"),
      );
      Vitest.expect(yield* invalidation.generation).toBe(1);

      const second = yield* nextChange;
      yield* invalidation.invalidate("package-install");
      Vitest.expect(yield* Fiber.join(second)).toEqual(
        Option.some("package-install"),
      );
      Vitest.expect(yield* invalidation.generation).toBe(2);
    }),
);
