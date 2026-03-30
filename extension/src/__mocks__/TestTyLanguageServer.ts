import { Effect, Layer, Option } from "effect";

import {
  TyLanguageServer,
  TyLanguageServerStatus,
} from "../lsp/TyLanguageServer.ts";
import { BinarySource } from "../lib/binaryResolution.ts";

/**
 * Test mock for TyLanguageServer.
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ty` language server during tests.
 */
export const TestTyLanguageServerLive = Layer.effect(
  TyLanguageServer,
  Effect.gen(function* () {
    yield* Effect.logWarning(
      "Using test mock for TyLanguageServer - skipping actual server startup",
    );
    return TyLanguageServer.make({
      getHealthStatus: () =>
        Effect.succeed(
          TyLanguageServerStatus.Running({
            serverVersion: "0.0.0-test",
            binarySource: BinarySource.UvInstalled({ path: "/test/ty" }),
            pythonEnvironment: Option.none(),
          }),
        ),
    });
  }),
);
