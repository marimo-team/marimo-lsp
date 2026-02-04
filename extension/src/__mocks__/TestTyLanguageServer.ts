import { Effect, Layer, Option } from "effect";
import {
  TyLanguageServer,
  TyLanguageServerStatus,
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
    getHealthStatus: () =>
      Effect.succeed(
        TyLanguageServerStatus.Running({
          client: {
            start: () => Effect.succeed(Option.none()),
            restart: () => Effect.void,
          },
          serverVersion: "0.0.0-test",
          pythonEnvironment: Option.none(),
        }),
      ),
  }),
);
