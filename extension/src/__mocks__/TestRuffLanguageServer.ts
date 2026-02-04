import { Effect, Layer, Option } from "effect";
import {
  RuffLanguageServer,
  RuffLanguageServerStatus,
} from "../services/completions/RuffLanguageServer.ts";

/**
 * Test mock for RuffLanguageServer
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ruff` language server during tests.
 */
export const TestRuffLanguageServerLive = Layer.succeed(
  RuffLanguageServer,
  RuffLanguageServer.make({
    getHealthStatus: () =>
      Effect.succeed(
        RuffLanguageServerStatus.Running({
          serverVersion: "0.0.0-test",
          client: {
            start: () => Effect.succeed(Option.none()),
            restart: () => Effect.void,
          },
        }),
      ),
  }),
);
