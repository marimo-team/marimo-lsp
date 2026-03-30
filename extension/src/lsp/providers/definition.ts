/**
 * Definition, declaration, and type definition provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/definition.ts
 *            vscode-languageserver-node/client/src/common/declaration.ts
 *            vscode-languageserver-node/client/src/common/typeDefinition.ts
 *
 * All three use the same pattern: textDocumentPositionParams →
 * Location | Location[] | LocationLink[]. Grouped in one file
 * because the only difference is the LSP method and capability key.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toDocumentPositionParams, toLocationResult } from "../converters.ts";

export const registerDefinitionProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.definitionProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDefinitionProvider(sel, {
    provideDefinition: Effect.fn(function* (doc, pos) {
      const result = yield* client.sendRequest(
        lsp.DefinitionRequest.method,
        toDocumentPositionParams(doc, pos),
      );
      return toLocationResult(code, result);
    }),
  });
});

export const registerDeclarationProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.declarationProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDeclarationProvider(sel, {
    provideDeclaration: Effect.fn(function* (doc, pos) {
      const result = yield* client.sendRequest(
        lsp.DeclarationRequest.method,
        toDocumentPositionParams(doc, pos),
      );
      return toLocationResult(code, result);
    }),
  });
});

export const registerTypeDefinitionProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.typeDefinitionProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerTypeDefinitionProvider(sel, {
    provideTypeDefinition: Effect.fn(function* (doc, pos) {
      const result = yield* client.sendRequest(
        lsp.TypeDefinitionRequest.method,
        toDocumentPositionParams(doc, pos),
      );
      return toLocationResult(code, result);
    }),
  });
});
