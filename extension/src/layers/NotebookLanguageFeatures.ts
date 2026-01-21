import { Effect, Layer } from "effect";
import { TyLanguageServer } from "../services/completions/TyLanguageServer.ts";

/**
 * Layer that ensures the ty language server is instantiated.
 *
 * ty provides native notebook support via its language client, so all LSP features
 * (completions, hover, definitions, signature help, semantic tokens) are automatically
 * registered through the LanguageClient infrastructure. The TyLanguageServer middleware
 * handles document transformation (mo-python -> python, .ipynb URI suffix) and
 * topological cell ordering.
 *
 * This layer simply ensures TyLanguageServer is started as part of the extension lifecycle.
 */
export const NotebookLanguageFeaturesLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    // Instantiate TyLanguageServer to ensure the ty language client starts
    // and registers its providers. All language features are handled natively
    // by the language client with our middleware.
    yield* TyLanguageServer;
    yield* Effect.logInfo(
      "ty language server instantiated for notebook language features",
    );
  }),
);
