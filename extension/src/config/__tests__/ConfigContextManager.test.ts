import { expect, it } from "@effect/vitest";
import { Effect, Layer, Option, Ref, Stream, SubscriptionRef } from "effect";
import { TestClock } from "effect/testing";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { marimoConfigFixture } from "../../lib/__tests__/branded.ts";
import type { MarimoConfig } from "../../types.ts";
import { ConfigContextManagerLive } from "../ConfigContextManager.ts";
import { MarimoConfigurationService } from "../MarimoConfigurationService.ts";

const withTestCtx = Effect.fn(function* () {
  const vscode = yield* TestVsCode.make();
  const configRef = yield* SubscriptionRef.make(Option.none<MarimoConfig>());

  const stubConfigService = Layer.succeed(
    MarimoConfigurationService,
    MarimoConfigurationService.of({
      getConfig: () => Effect.die("not implemented"),
      updateConfig: () => Effect.die("not implemented"),
      clearNotebook: () => Effect.die("not implemented"),
      streamOf: (mapper) =>
        SubscriptionRef.changes(configRef).pipe(
          Stream.map((config) => Option.map(config, mapper)),
          Stream.changes,
        ),
    }),
  );

  const layer = ConfigContextManagerLive.pipe(
    Layer.provide(stubConfigService),
    Layer.provide(vscode.layer),
  );

  return { vscode, configRef, layer };
});

it.effect("mirrors kernel config into VS Code context keys", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    yield* Layer.build(ctx.layer);
    yield* TestClock.adjust("10 millis");

    // No active config yet: defaults apply
    const initial = yield* Ref.get(ctx.vscode.executions);
    expect(initial).toContainEqual({
      command: "setContext",
      args: ["marimo.config.runtime.on_cell_change", "autorun"],
    });
    expect(initial).toContainEqual({
      command: "setContext",
      args: ["marimo.config.runtime.auto_reload", "off"],
    });

    yield* SubscriptionRef.set(
      ctx.configRef,
      Option.some(
        marimoConfigFixture({
          runtime: { on_cell_change: "lazy", auto_reload: "autorun" },
        }),
      ),
    );
    yield* TestClock.adjust("10 millis");

    const updated = yield* Ref.get(ctx.vscode.executions);
    expect(updated).toContainEqual({
      command: "setContext",
      args: ["marimo.config.runtime.on_cell_change", "lazy"],
    });
    expect(updated).toContainEqual({
      command: "setContext",
      args: ["marimo.config.runtime.auto_reload", "autorun"],
    });
  }),
);
