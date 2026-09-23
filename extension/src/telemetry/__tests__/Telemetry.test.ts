import { Effect, Layer } from "effect";

import { TestExtensionContextLive } from "../../__mocks__/TestExtensionContext.ts";
import * as TestVsCode from "../../__mocks__/TestVsCode.ts";
import * as EffectTest from "../../__tests__/__utils__/EffectTest.ts";
import * as Telemetry from "../Telemetry.ts";

const it = EffectTest.make(
  Telemetry.layer.pipe(
    Layer.provide(
      TestVsCode.layerWith({
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
      }),
    ),
    Layer.provide(TestExtensionContextLive),
  ),
);

it.effect(
  "is inert when telemetry is disabled",
  Effect.fn(function* () {
    const telemetry = yield* Telemetry.Service;

    yield* telemetry.notebookCreated;
    yield* telemetry.lspStarted("wasm");
    yield* telemetry.tySetup("install");
  }),
);
