import { it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { TestExtensionContextLive } from "../../__mocks__/TestExtensionContext.ts";
import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { Telemetry } from "../Telemetry.ts";

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
  }),
);
