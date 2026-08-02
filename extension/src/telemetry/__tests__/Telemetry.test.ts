import { expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { vi } from "vite-plus/test";
import type * as vscode from "vscode";

import { TestExtensionContextLive } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Telemetry } from "../Telemetry.ts";

const sentrySdk = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  close: vi.fn(async () => true),
}));

const posthog = vi.hoisted(() => ({
  instances: [] as Array<{ capture: ReturnType<typeof vi.fn> }>,
  capture: vi.fn(),
  shutdown: vi.fn(async () => undefined),
}));

vi.mock("@sentry/node", () => sentrySdk);

vi.mock("posthog-node", () => ({
  PostHog: class {
    capture = posthog.capture;
    shutdown = posthog.shutdown;
  },
}));

const telemetryChange: vscode.ConfigurationChangeEvent = {
  affectsConfiguration: (section) => section === "marimo.telemetry",
};

const withTestCtx = Effect.fn(function* (options?: { telemetry?: boolean }) {
  sentrySdk.init.mockClear();
  sentrySdk.close.mockClear();
  posthog.capture.mockClear();
  posthog.shutdown.mockClear();

  let telemetry = options?.telemetry ?? true;
  // A Queue (not a PubSub) so events published before the service's forked
  // fiber subscribes are buffered instead of dropped.
  const changes = yield* Queue.unbounded<vscode.ConfigurationChangeEvent>();
  const vscodeMock = yield* TestVsCode.make({
    workspace: {
      configurationChanges: () => Stream.fromQueue(changes),
      getConfiguration: (section) =>
        Effect.succeed({
          // oxlint-disable-next-line typescript/no-unnecessary-type-parameters
          get: <T>(key: string, defaultValue?: T) => {
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion
            return (
              section === "marimo" && key === "telemetry"
                ? telemetry
                : defaultValue
            ) as T;
          },
          has: (key: string) => section === "marimo" && key === "telemetry",
          inspect: () => undefined,
          async update() {},
        }),
    },
  });

  const context = yield* Layer.build(
    Telemetry.Default.pipe(
      Layer.provide(vscodeMock.layer),
      Layer.provide(TestExtensionContextLive),
    ),
  );

  return {
    telemetry: yield* Telemetry.pipe(Effect.provide(context)),
    setTelemetry: (value: boolean) =>
      Effect.suspend(() => {
        telemetry = value;
        return Queue.offer(changes, telemetryChange);
      }),
  };
});

const waitFor = (assertion: () => void) =>
  Effect.promise(() => vi.waitFor(assertion));

it.scoped("releases both sinks on consent loss and re-acquires them", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    expect(sentrySdk.init).toHaveBeenCalledTimes(1);
    // Activation event goes to PostHog on acquire
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "extension_activated" }),
    );

    yield* ctx.setTelemetry(false);
    yield* waitFor(() => expect(sentrySdk.close).toHaveBeenCalledTimes(1));
    expect(posthog.shutdown).toHaveBeenCalledTimes(1);

    yield* ctx.setTelemetry(true);
    yield* waitFor(() => expect(sentrySdk.init).toHaveBeenCalledTimes(2));
  }),
);

it.scoped("capture is a no-op without consent, live with it", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx({ telemetry: false });
    expect(sentrySdk.init).not.toHaveBeenCalled();

    yield* ctx.telemetry.capture("new_notebook_created");
    expect(posthog.capture).not.toHaveBeenCalled();

    yield* ctx.setTelemetry(true);
    yield* waitFor(() => expect(sentrySdk.init).toHaveBeenCalledTimes(1));

    yield* ctx.telemetry.capture("new_notebook_created");
    expect(posthog.capture).toHaveBeenCalledWith(
      expect.objectContaining({ event: "new_notebook_created" }),
    );
  }),
);
