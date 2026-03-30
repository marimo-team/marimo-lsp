/**
 * Document symbol provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/documentSymbol.ts
 *
 * Handles hierarchical DocumentSymbol (with children) responses.
 * SymbolKind values match between LSP and VS Code (both 1-based).
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toDocumentSymbol } from "../converters.ts";

export const registerDocumentSymbolProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.documentSymbolProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDocumentSymbolProvider(sel, {
    provideDocumentSymbols: Effect.fn(function* (doc) {
      const result = yield* client.sendRequest(
        lsp.DocumentSymbolRequest.method,
        {
          textDocument: { uri: doc.uri.toString() },
        },
      );
      return result?.map((s) => toDocumentSymbol(code, s)) ?? [];
    }),
  });
});
