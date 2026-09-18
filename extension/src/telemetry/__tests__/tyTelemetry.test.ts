import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vite-plus/test";

import { Memento } from "../../__mocks__/TestExtensionContext.ts";
import { Uri } from "../../__mocks__/TestVsCode.ts";
import { ExtensionContext, Storage } from "../../platform/Storage.ts";
import { makeTyTelemetry, type TyTelemetryEvent } from "../tyTelemetry.ts";

const makeHarness = Effect.fn(function* () {
  const workspaceState = new Memento();
  const storage = yield* Storage.make.pipe(
    Effect.provideService(ExtensionContext, {
      workspaceState,
      globalState: new Memento(),
      extensionUri: Uri.file("/extension"),
      globalStorageUri: Uri.file("/storage"),
    }),
  );
  const events: TyTelemetryEvent[] = [];
  const gate = { enabled: true };
  return {
    events,
    gate,
    writes: vi.spyOn(workspaceState, "update"),
    activate: (activationId: string) =>
      makeTyTelemetry({
        activationId,
        storage,
        enabled: () => gate.enabled,
        emit: (event) =>
          Effect.sync(() => {
            events.push(event);
          }),
      }),
  };
});

for (const outcome of ["ready", "missing", "failed", "disabled"] as const) {
  it.effect(
    `correlates installation with ${outcome} on the next activation only once`,
    Effect.fn(function* () {
      const test = yield* makeHarness();
      const first = yield* test.activate("before-reload");
      yield* first.installStarted;
      yield* first.installFinished("succeeded");
      yield* first.stateChanged({ state: "missing" });
      expect(
        test.events.some(
          (event) => event.event === "ty_install_activation_result",
        ),
      ).toBe(false);

      const second = yield* test.activate("after-reload");
      yield* second.stateChanged({ state: "starting" });
      const state =
        outcome === "ready"
          ? {
              state: outcome,
              source: "UserConfigured" as const,
              version: "0.0.63",
            }
          : { state: outcome };
      yield* second.stateChanged(state);
      yield* second.stateChanged(state);
      const third = yield* test.activate("later-reload");
      yield* third.stateChanged(state);

      const started = test.events.find(
        (event) => event.event === "ty_install_started",
      );
      expect(started).toMatchObject({
        attempt_id: expect.any(String),
        install_activation_id: "before-reload",
      });
      expect(
        test.events.filter(
          (event) => event.event === "ty_install_activation_result",
        ),
      ).toEqual([
        {
          event: "ty_install_activation_result",
          outcome,
          attempt_id: started?.attempt_id,
          install_activation_id: "before-reload",
        },
      ]);
    }),
  );
}

it.effect(
  "does not attribute a later startup to a failed install; retries have distinct IDs",
  Effect.fn(function* () {
    const test = yield* makeHarness();
    const first = yield* test.activate("first");
    yield* first.installStarted;
    yield* first.installFinished("failed");
    const second = yield* test.activate("second");
    yield* second.stateChanged({ state: "missing" });
    expect(
      test.events.some(
        (event) => event.event === "ty_install_activation_result",
      ),
    ).toBe(false);
    yield* second.installStarted;
    const attempts = test.events.filter(
      (event) => event.event === "ty_install_started",
    );
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.attempt_id).not.toBe(attempts[1]?.attempt_id);
  }),
);

it.effect(
  "records each feature once per activation, including after server restarts",
  Effect.fn(function* () {
    const test = yield* makeHarness();
    const first = yield* test.activate("first");
    yield* Effect.all(
      [first.featureUsed("hover"), first.featureUsed("hover")],
      { concurrency: "unbounded" },
    );
    yield* first.stateChanged({ state: "starting" });
    yield* first.featureUsed("hover");
    yield* first.featureUsed("completion");
    yield* first.featureUsed("navigation");
    yield* first.featureUsed("diagnostics");
    const second = yield* test.activate("second");
    yield* second.featureUsed("hover");
    expect(
      test.events
        .filter((event) => event.event === "ty_feature_used")
        .map((event) => event.feature),
    ).toEqual(["hover", "completion", "navigation", "diagnostics", "hover"]);
  }),
);

it.effect(
  "does not emit or persist while usage telemetry is disabled",
  Effect.fn(function* () {
    const test = yield* makeHarness();
    test.gate.enabled = false;
    const telemetry = yield* test.activate("first");
    yield* telemetry.stateChanged({ state: "missing" });
    yield* telemetry.prompt("shown", false);
    yield* telemetry.installStarted;
    yield* telemetry.installFinished("succeeded");
    yield* telemetry.featureUsed("hover");
    expect(test.events).toEqual([]);
    expect(test.writes).not.toHaveBeenCalled();

    test.gate.enabled = true;
    yield* telemetry.featureUsed("hover");
    test.gate.enabled = false;
    yield* telemetry.featureUsed("completion");
    expect(test.events).toEqual([
      { event: "ty_feature_used", feature: "hover" },
    ]);
  }),
);

it.effect(
  "storage failures do not prevent installation telemetry",
  Effect.fn(function* () {
    const test = yield* makeHarness();
    test.writes.mockRejectedValue(new Error("storage unavailable"));
    const telemetry = yield* test.activate("first");
    yield* telemetry.installStarted;
    yield* telemetry.installFinished("failed");
    expect(test.events.map((event) => event.event)).toEqual([
      "ty_install_started",
      "ty_install_finished",
    ]);
  }),
);
