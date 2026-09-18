import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { afterEach, vi } from "vite-plus/test";

import { TestExtensionContextLive } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { ExtensionContext } from "../../platform/Storage.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { Telemetry } from "../Telemetry.ts";

const { capture } = vi.hoisted(() => {
  // Tests share module caches (isolate: false); reload Telemetry so these
  // private sink mocks also apply when another test imported it first.
  vi.resetModules();
  return { capture: vi.fn() };
});
vi.mock("../posthogSink.ts", async () => {
  const { Effect } = await import("effect");
  return { acquirePostHogAdapter: Effect.succeed({ capture }) };
});
vi.mock("../sentrySink.ts", async () => {
  const { Effect } = await import("effect");
  return {
    acquireSentryAdapter: () =>
      Effect.succeed({
        captureError() {},
        addBreadcrumb() {},
        setBinaryVersion() {},
        setLspMode() {},
      }),
  };
});
afterEach(() => {
  vi.unstubAllEnvs();
  capture.mockClear();
});

it.effect(
  "is inert when telemetry is disabled",
  Effect.fn(function* () {
    const code = yield* TestVsCode.make({
      env: {
        createTelemetryLogger() {
          return Effect.die("disabled telemetry acquired a logger");
        },
      },
      workspace: {
        getConfiguration: (section) =>
          Effect.succeed({
            // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
            get: <T>(key: string, defaultValue?: T) => {
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion
              return (
                section === "marimo" && key === "telemetry"
                  ? false
                  : defaultValue
              ) as T;
            },
            has: (key: string) => section === "marimo" && key === "telemetry",
            inspect: () => undefined,
            async update() {},
          }),
      },
    });
    const telemetry = yield* Telemetry.pipe(
      Effect.provide(
        Telemetry.layer.pipe(
          Layer.provide(code.layer),
          Layer.provide(TestExtensionContextLive),
        ),
      ),
    );

    yield* telemetry.notebookCreated;
    yield* telemetry.lspStarted("wasm");
    yield* telemetry.ty.installStarted;
    yield* telemetry.ty.featureUsed("hover");
    expect(capture).not.toHaveBeenCalled();
  }),
);

it.effect(
  "joins notebook and ty events by activation, renewing the ID after reload",
  Effect.fn(function* () {
    const code = yield* TestVsCode.make();
    const activate = Effect.gen(function* () {
      const telemetry = yield* Telemetry;
      yield* telemetry.notebookOpened(1);
      yield* telemetry.ty.stateChanged({ state: "missing" });
    }).pipe(
      Effect.provide(
        Telemetry.layer.pipe(
          Layer.provide(code.layer),
          Layer.provide(TestExtensionContextLive),
        ),
      ),
    );
    yield* activate;
    yield* activate;
    expect(capture.mock.calls.map(([event]) => event.event)).toEqual([
      "extension_activated",
      "notebook_opened",
      "ty_status",
      "extension_activated",
      "notebook_opened",
      "ty_status",
    ]);
    const ids = capture.mock.calls.map(
      ([event]) => event.properties.activation_id,
    );
    expect(ids[0]).toEqual(expect.any(String));
    expect(ids.slice(0, 3)).toEqual([ids[0], ids[0], ids[0]]);
    expect(ids.slice(3)).toEqual([ids[3], ids[3], ids[3]]);
    expect(ids[0]).not.toBe(ids[3]);
  }),
);

for (const mode of ["replay", 2, 3] as const) {
  it.effect(
    `excludes local mode ${mode} from ty metrics and marks its cohort events`,
    Effect.fn(function* () {
      if (mode === "replay") vi.stubEnv("MARIMO_REPLAY_TY_PROMPT", "1");
      const code = yield* TestVsCode.make();
      const context = yield* ExtensionContext.pipe(
        Effect.provide(TestExtensionContextLive),
      );
      yield* Effect.gen(function* () {
        const telemetry = yield* Telemetry;
        yield* telemetry.notebookOpened(1);
        yield* telemetry.ty.stateChanged({ state: "missing" });
        yield* telemetry.ty.prompt("shown", false);
        yield* telemetry.ty.installStarted;
        yield* telemetry.ty.installFinished("succeeded");
        yield* telemetry.ty.featureUsed("hover");
      }).pipe(
        Effect.provide(
          Telemetry.layer.pipe(
            Layer.provide(code.layer),
            Layer.provide(
              Layer.succeed(ExtensionContext, {
                ...context,
                extensionMode: mode === "replay" ? 1 : mode,
              }),
            ),
          ),
        ),
      );
      expect(capture.mock.calls.map(([event]) => event.event)).toEqual([
        "extension_activated",
        "notebook_opened",
      ]);
      expect(
        capture.mock.calls.every(
          ([event]) => event.properties.development === true,
        ),
      ).toBe(true);
    }),
  );
}

it.effect(
  "uses VS Code's usage consent gate for ty tracking",
  Effect.fn(function* () {
    const base = yield* TestVsCode.make();
    const baseCode = yield* VsCode.pipe(Effect.provide(base.layer));
    const code = yield* TestVsCode.make({
      env: {
        createTelemetryLogger: (sender, options) =>
          baseCode.env
            .createTelemetryLogger(sender, options)
            .pipe(
              Effect.map((logger) => ({ ...logger, isUsageEnabled: false })),
            ),
      },
    });
    yield* Effect.gen(function* () {
      const telemetry = yield* Telemetry;
      yield* telemetry.ty.stateChanged({ state: "missing" });
      yield* telemetry.ty.installStarted;
      yield* telemetry.ty.featureUsed("hover");
    }).pipe(
      Effect.provide(
        Telemetry.layer.pipe(
          Layer.provide(code.layer),
          Layer.provide(TestExtensionContextLive),
        ),
      ),
    );
    expect(
      capture.mock.calls.some(([event]) => event.event.startsWith("ty_")),
    ).toBe(false);
  }),
);
