/**
 * Registers VS Code language feature providers for a notebook LSP client,
 * driven by the server's advertised capabilities.
 *
 * Each provider is implemented in its own file under `../lsp/providers/`,
 * modeled after the reference implementation in vscode-languageserver-node.
 */

import { Effect } from "effect";
// oxlint-disable-next-line marimo/vscode-type-only
import * as vscode from "vscode";

import { LanguageId } from "../../constants.ts";
import type { NotebookLspClient } from "../../utils/makeMarimoLspClient.ts";
import {
  registerDeclarationProvider,
  registerDefinitionProvider,
  registerTypeDefinitionProvider,
} from "../lsp/providers/definition.ts";
import { registerDocumentHighlightProvider } from "../lsp/providers/documentHighlight.ts";
import { registerDocumentSymbolProvider } from "../lsp/providers/documentSymbol.ts";
import { registerFoldingRangeProvider } from "../lsp/providers/foldingRange.ts";
import {
  registerDocumentFormattingProvider,
  registerDocumentRangeFormattingProvider,
} from "../lsp/providers/formatting.ts";
import { registerHoverProvider } from "../lsp/providers/hover.ts";
import { registerReferenceProvider } from "../lsp/providers/references.ts";
import { registerSelectionRangeProvider } from "../lsp/providers/selectionRange.ts";
import { registerSignatureHelpProvider } from "../lsp/providers/signatureHelp.ts";

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
  },
);
