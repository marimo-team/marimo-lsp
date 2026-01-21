import { Effect, Layer, Option } from "effect";
import {
  TyLanguageServer,
  TyLanguageServerHealth,
} from "../services/completions/TyLanguageServer.ts";

/**
 * Test mock for TyLanguageServer.
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ty` language server during tests.
 */
export const TestTyLanguageServerLive = Layer.succeed(
  TyLanguageServer,
  TyLanguageServer.make({
    restart: () => Effect.void,
    getHealthStatus: Effect.succeed(
      TyLanguageServerHealth.Running({
        version: Option.some("0.0.0-test"),
        pythonEnvironment: Option.none(),
      }),
    ),
  }),
);
