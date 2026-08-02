import { expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";
import { vi } from "vite-plus/test";
import type * as vscode from "vscode";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Sentry } from "../Sentry.ts";

const sentrySdk = vi.hoisted(() => ({
  init: vi.fn(),
  setTag: vi.fn(),
  setUser: vi.fn(),
  close: vi.fn(async () => true),
}));

vi.mock("@sentry/node", () => sentrySdk);

const telemetryChange: vscode.ConfigurationChangeEvent = {
  affectsConfiguration: (section) => section === "marimo.telemetry",
};

const withTestCtx = Effect.fn(function* () {
  sentrySdk.init.mockClear();
  sentrySdk.close.mockClear();

  let telemetry = true;
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

  yield* Layer.build(Sentry.Default.pipe(Layer.provide(vscodeMock.layer)));

  return {
    setTelemetry: (value: boolean) =>
      Effect.suspend(() => {
        telemetry = value;
        return Queue.offer(changes, telemetryChange);
      }),
  };
});

const waitFor = (assertion: () => void) =>
  Effect.promise(() => vi.waitFor(assertion));

it.scoped("closes the Sentry client when telemetry is turned off", () =>
  Effect.gen(function* () {
    const ctx = yield* withTestCtx();
    expect(sentrySdk.init).toHaveBeenCalledTimes(1);
    expect(sentrySdk.close).not.toHaveBeenCalled();

    yield* ctx.setTelemetry(false);
    yield* waitFor(() => expect(sentrySdk.close).toHaveBeenCalledTimes(1));
    expect(sentrySdk.init).toHaveBeenCalledTimes(1);

    yield* ctx.setTelemetry(true);
    yield* waitFor(() => expect(sentrySdk.init).toHaveBeenCalledTimes(2));
  }),
);
