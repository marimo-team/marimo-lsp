/**
 * Registers VS Code language feature providers for a notebook LSP client,
 * driven by the server's advertised capabilities.
 *
 * Each provider is implemented in its own file under `./providers/`,
 * modeled after the reference implementation in vscode-languageserver-node.
 */

import { Effect } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { LanguageId } from "../constants.ts";
import type { NotebookLspClient } from "./client.ts";
import { registerCodeActionProvider } from "./providers/codeAction.ts";
import { registerCompletionProvider } from "./providers/completion.ts";
import {
  registerDeclarationProvider,
  registerDefinitionProvider,
  registerTypeDefinitionProvider,
} from "./providers/definition.ts";
import { registerDocumentHighlightProvider } from "./providers/documentHighlight.ts";
import { registerDocumentSymbolProvider } from "./providers/documentSymbol.ts";
import { registerFoldingRangeProvider } from "./providers/foldingRange.ts";
import {
  registerDocumentFormattingProvider,
  registerDocumentRangeFormattingProvider,
} from "./providers/formatting.ts";
import { registerHoverProvider } from "./providers/hover.ts";
import { registerInlayHintProvider } from "./providers/inlayHint.ts";
import { registerReferenceProvider } from "./providers/references.ts";
import { registerRenameProvider } from "./providers/rename.ts";
import { registerSelectionRangeProvider } from "./providers/selectionRange.ts";
import { registerSemanticTokensProvider } from "./providers/semanticTokens.ts";
import { registerSignatureHelpProvider } from "./providers/signatureHelp.ts";

export const registerLspProviders = Effect.fn("registerLspProviders")(
  function* (client: NotebookLspClient) {
    const sel: vscode.DocumentSelector = [
      { scheme: "vscode-notebook-cell", language: LanguageId.Python },
    ];

    yield* registerHoverProvider(sel, client);
    yield* registerDefinitionProvider(sel, client);
    yield* registerDeclarationProvider(sel, client);
    yield* registerTypeDefinitionProvider(sel, client);
    yield* registerReferenceProvider(sel, client);
    yield* registerDocumentHighlightProvider(sel, client);
    yield* registerDocumentSymbolProvider(sel, client);
    yield* registerFoldingRangeProvider(sel, client);
    yield* registerSelectionRangeProvider(sel, client);
    yield* registerDocumentFormattingProvider(sel, client);
    yield* registerDocumentRangeFormattingProvider(sel, client);
    yield* registerSignatureHelpProvider(sel, client);
    yield* registerInlayHintProvider(sel, client);
    yield* registerCompletionProvider(sel, client);
    yield* registerCodeActionProvider(sel, client);
    yield* registerRenameProvider(sel, client);
    yield* registerSemanticTokensProvider(sel, client);
  },
);
