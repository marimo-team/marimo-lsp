import * as Vitest from "@effect/vitest";
import { Effect } from "effect";

import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as TestConfigContextManager from "./TestConfigContextManager.ts";

Vitest.describe("ConfigContextManager", () => {
  const it = EffectTest.make(TestConfigContextManager.layer);

  it.effect(
    "mirrors the active session configuration into context keys",
    Effect.fn(function* () {
      const context = yield* TestConfigContextManager.Service;
      yield* context.defaultsWritten;

      const initial = yield* context.writes;
      Vitest.expect(initial).toContainEqual({
        key: "marimo.config.runtime.on_cell_change",
        value: "autorun",
      });
      Vitest.expect(initial).toContainEqual({
        key: "marimo.config.runtime.auto_reload",
        value: "off",
      });

      yield* context.activateFirst;
      yield* context.firstConfigurationWritten;
      const updated = yield* context.writes;
      Vitest.expect(updated).toContainEqual({
        key: "marimo.config.runtime.on_cell_change",
        value: "lazy",
      });
      Vitest.expect(updated).toContainEqual({
        key: "marimo.config.runtime.auto_reload",
        value: "autorun",
      });
    }),
  );

  Vitest.describe("when an earlier context write is blocked", () => {
    const it = EffectTest.make(
      TestConfigContextManager.layerWith(
        TestConfigContextManager.Scenario.BlockFirstWrite(),
      ),
    );

    it.effect(
      "keeps context writes ordered when the active session changes",
      Effect.fn(function* () {
        const context = yield* TestConfigContextManager.Service;
        yield* context.defaultsWritten;
        yield* context.activateFirst;
        yield* context.firstWriteStarted;

        yield* context.activateSecond;
        yield* context.secondConfigurationLoaded;
        yield* Effect.yieldNow;
        yield* context.releaseFirstWrite;
        yield* context.secondConfigurationWritten;

        const latest = new Map(
          (yield* context.writes).map(({ key, value }) => [key, value]),
        );
        Vitest.expect(latest.get("marimo.config.runtime.on_cell_change")).toBe(
          "autorun",
        );
        Vitest.expect(latest.get("marimo.config.runtime.auto_reload")).toBe(
          "lazy",
        );
      }),
    );
  });
});
