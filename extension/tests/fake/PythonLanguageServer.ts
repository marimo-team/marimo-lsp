import { Effect, Layer, Option } from "effect";

import { BinarySource } from "../../src/lib/binaryResolution.ts";
import * as PythonLanguageServer from "../../src/lsp/PythonLanguageServer.ts";

/**
 * Test mock for PythonLanguageServer.
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ty` language server during tests.
 */
export const layer = Layer.succeed(PythonLanguageServer.Service, {
  getHealthStatus: Effect.succeed(
    PythonLanguageServer.Status.Running({
      server: "ty",
      serverVersion: "0.0.0-test",
      binarySource: BinarySource.UserConfigured({ path: "/test/ty" }),
      pythonEnvironment: Option.none(),
    }),
  ),
});
