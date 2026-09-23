import { Effect, Layer, Option } from "effect";

import { BinarySource } from "../lib/binaryResolution.ts";
import * as TyLanguageServer from "../lsp/TyLanguageServer.ts";

/**
 * Test mock for TyLanguageServer.
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ty` language server during tests.
 */
export const TestTyLanguageServerLive = Layer.effect(
  TyLanguageServer.Service,
  Effect.gen(function* () {
    yield* Effect.logWarning(
      "Using test mock for TyLanguageServer - skipping actual server startup",
    );
    return {
      getHealthStatus: Effect.succeed(
        TyLanguageServer.Status.Running({
          serverVersion: "0.0.0-test",
          binarySource: BinarySource.UserConfigured({ path: "/test/ty" }),
          pythonEnvironment: Option.none(),
        }),
      ),
    };
  }),
);
