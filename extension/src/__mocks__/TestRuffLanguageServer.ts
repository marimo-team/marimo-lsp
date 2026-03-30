import { Effect, Layer } from "effect";

import {
  RuffLanguageServer,
  RuffLanguageServerStatus,
} from "../lsp/RuffLanguageServer.ts";
import { BinarySource } from "../lib/binaryResolution.ts";

/**
 * Test mock for RuffLanguageServer
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ruff` language server during tests.
 */
export const TestRuffLanguageServerLive = Layer.effect(
  RuffLanguageServer,
  Effect.gen(function* () {
    yield* Effect.logWarning(
      "Using test mock for RuffLanguageServer - skipping actual server startup",
    );
    return RuffLanguageServer.make({
      getHealthStatus: () =>
        Effect.succeed(
          RuffLanguageServerStatus.Running({
            serverVersion: "0.0.0-test",
            binarySource: BinarySource.UvInstalled({ path: "/test/ruff" }),
          }),
        ),
    });
  }),
);
