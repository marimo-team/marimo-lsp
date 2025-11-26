import { Effect, Layer, Option, Runtime } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { Constants } from "../services/Constants.ts";
import { LspProxy } from "../services/completions/LspProxy.ts";
import { VsCode } from "../services/VsCode.ts";
import { signalFromToken } from "../utils/signalFromToken.ts";

/**
 * Language feature provider that uses virtual documents to provide LSP features
 * (completions, hover, definitions, signature help) across topologically-sorted marimo cells.
 */
export const NotebookLanguageFeaturesLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const code = yield* VsCode;
    const proxy = yield* LspProxy;
    const constants = yield* Constants;

    const runtime = yield* Effect.runtime();
    const runPromise = Runtime.runPromise(runtime);

    const selector = {
      language: constants.LanguageId.Python,
      notebookType: NOTEBOOK_TYPE,
    } satisfies vscode.DocumentSelector;

    yield* code.languages.registerCompletionItemProvider(
      selector,
      {
        provideCompletionItems(document, position, token, context) {
          return runPromise(
            proxy.provideCompletionItems(document, position, context),
            { signal: signalFromToken(token) },
          );
        },
      },
      ".", // Trigger on dot for member completions
      " ", // Trigger on space for general completions
    );

    yield* code.languages.registerHoverProvider(selector, {
      provideHover(document, position, token) {
        return runPromise(proxy.provideHover(document, position), {
          signal: signalFromToken(token),
        });
      },
    });

    yield* code.languages.registerDefinitionProvider(selector, {
      provideDefinition(document, position, token) {
        return runPromise(proxy.provideDefinition(document, position), {
          signal: signalFromToken(token),
        });
      },
    });

    yield* code.languages.registerSignatureHelpProvider(
      selector,
      {
        provideSignatureHelp(document, position, token, context) {
          return runPromise(
            proxy.provideSignatureHelp(document, position, context),
            { signal: signalFromToken(token) },
          );
        },
      },
      "(", // Trigger on open parenthesis
      ",", // Trigger on comma
    );

    // Register semantic tokens provider for enhanced syntax highlighting
    // This provides semantic highlighting (e.g., distinguishing variables from
    // functions, classes, etc.) that goes beyond basic TextMate grammar highlighting.
    const legend = yield* proxy.getSemanticTokensLegend();
    if (Option.isSome(legend)) {
      yield* code.languages.registerDocumentSemanticTokensProvider(
        selector,
        {
          provideDocumentSemanticTokens(document, token) {
            return runPromise(proxy.provideDocumentSemanticTokens(document), {
              signal: signalFromToken(token),
            });
          },
        },
        legend.value,
      );
    } else {
      yield* Effect.logWarning(
        "Semantic tokens legend not available; skipping registration of semantic tokens provider.",
      );
    }
  }),
);
