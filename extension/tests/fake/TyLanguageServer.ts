import { Effect, Layer, Option } from "effect";

import { BinarySource } from "../../src/lib/binaryResolution.ts";
import * as TyLanguageServer from "../../src/lsp/TyLanguageServer.ts";

/**
 * Test mock for TyLanguageServer.
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ty` language server during tests.
 */
export const layer = Layer.succeed(TyLanguageServer.Service, {
  getHealthStatus: Effect.succeed(
    TyLanguageServer.Status.Running({
      serverVersion: "0.0.0-test",
      binarySource: BinarySource.UserConfigured({ path: "/test/ty" }),
      pythonEnvironment: Option.none(),
    }),
  ),
});
