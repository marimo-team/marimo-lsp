import { Effect, Layer } from "effect";

import { BinarySource } from "../lib/binaryResolution.ts";
import * as RuffLanguageServer from "../lsp/RuffLanguageServer.ts";

/**
 * Test mock for RuffLanguageServer
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ruff` language server during tests.
 */
export const TestRuffLanguageServerLive = Layer.effect(
  RuffLanguageServer.Service,
  Effect.gen(function* () {
    yield* Effect.logWarning(
      "Using test mock for RuffLanguageServer - skipping actual server startup",
    );
    return {
      getHealthStatus: Effect.succeed(
        RuffLanguageServer.Status.Running({
          serverVersion: "0.0.0-test",
          binarySource: BinarySource.UserConfigured({ path: "/test/ruff" }),
        }),
      ),
    };
  }),
);
