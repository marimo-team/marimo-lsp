import { Effect, Layer, Runtime } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";
import { LspProxy } from "../services/completions/LspProxy.ts";
import { VsCode } from "../services/VsCode.ts";

/**
 * Language feature provider that uses virtual documents to provide LSP features
 * (completions, hover, definitions, signature help) across topologically-sorted marimo cells.
 */
export const NotebookLanguageFeaturesLive = Layer.scopedDiscard(
  Effect.gen(function*() {
    const code = yield* VsCode;
    const proxy = yield* LspProxy;

    const runtime = yield* Effect.runtime();
    const runPromise = Runtime.runPromise(runtime);

    yield* code.languages.registerCompletionItemProvider(
      { language: "python", notebookType: NOTEBOOK_TYPE },
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

    yield* code.languages.registerHoverProvider(
      { language: "python", notebookType: NOTEBOOK_TYPE },
      {
        provideHover(document, position, token) {
          return runPromise(proxy.provideHover(document, position), {
            signal: signalFromToken(token),
          });
        },
      },
    );

    yield* code.languages.registerDefinitionProvider(
      { language: "python", notebookType: NOTEBOOK_TYPE },
      {
        provideDefinition(document, position, token) {
          return runPromise(proxy.provideDefinition(document, position), {
            signal: signalFromToken(token),
          });
        },
      },
    );

    yield* code.languages.registerSignatureHelpProvider(
      { language: "python", notebookType: NOTEBOOK_TYPE },
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
  }),
);

function signalFromToken(token: vscode.CancellationToken) {
  const controller = new AbortController();
  if (token.isCancellationRequested) {
    controller.abort();
  }
  token.onCancellationRequested(() => {
    controller.abort();
  });
  return controller.signal;
}
