import { Effect, Layer, Option } from "effect";
import { PythonLanguageServer } from "../services/completions/PythonLanguageServer.ts";

/**
 * Test mock for PythonLanguageServer.
 *
 * Provides stub implementations that return empty/null responses,
 * avoiding the need to start an actual `ty` language server during tests.
 */
export const TestPythonLanguageServerLive = Layer.succeed(
  PythonLanguageServer,
  PythonLanguageServer.make({
    restart: () => Effect.void,
    openDocument: () => Effect.void,
    updateDocument: () => Effect.void,
    closeDocument: () => Effect.void,
    getCompletions: () => Effect.succeed(null),
    getHover: () => Effect.succeed(null),
    getDefinition: () => Effect.succeed(null),
    getSignatureHelp: () => Effect.succeed(null),
    getSemanticTokensLegend: () => Effect.succeed(Option.none()),
    getSemanticTokensFull: () => Effect.succeed(Option.none()),
    getHealthStatus: Effect.succeed({
      status: "running" as const,
      version: null,
      error: null,
      pythonEnvironment: null,
    }),
  }),
);
