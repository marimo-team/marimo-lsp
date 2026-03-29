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

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function toVscodeRange(code: VsCode, range: lsp.Range): vscode.Range {
  return new code.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

function toLocation(code: VsCode, loc: lsp.Location): vscode.Location {
  return new code.Location(
    code.Uri.parse(loc.uri),
    toVscodeRange(code, loc.range),
  );
}

function toLocationLink(
  code: VsCode,
  link: lsp.LocationLink,
): vscode.LocationLink {
  return {
    targetUri: code.Uri.parse(link.targetUri),
    targetRange: toVscodeRange(code, link.targetRange),
    targetSelectionRange: toVscodeRange(code, link.targetSelectionRange),
    originSelectionRange: link.originSelectionRange
      ? toVscodeRange(code, link.originSelectionRange)
      : undefined,
  };
}

/**
 * Convert LSP definition result to VS Code types.
 *
 * Reference: protocolConverter.ts asLocationResult
 */
export function toLocationResult(
  code: VsCode,
  item: lsp.Definition | lsp.DefinitionLink[] | null,
): vscode.Location | vscode.Location[] | vscode.LocationLink[] | undefined {
  if (!item) return undefined;
  if (Array.isArray(item)) {
    if (item.length === 0) return [];
    if (lsp.LocationLink.is(item[0])) {
      return (item as lsp.LocationLink[]).map((l) => toLocationLink(code, l));
    }
    return (item as lsp.Location[]).map((l) => toLocation(code, l));
  }
  return toLocation(code, item);
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerDefinitionProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.definitionProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDefinitionProvider(sel, {
    provideDefinition: (doc, pos) =>
      client
        .sendRequest(lsp.DefinitionRequest.method, {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
        })
        .pipe(Effect.map((r) => toLocationResult(code, r))),
  });
});

export const registerDeclarationProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.declarationProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDeclarationProvider(sel, {
    provideDeclaration: (doc, pos) =>
      client
        .sendRequest(lsp.DeclarationRequest.method, {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
        })
        .pipe(Effect.map((r) => toLocationResult(code, r))),
  });
});

export const registerTypeDefinitionProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.typeDefinitionProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerTypeDefinitionProvider(sel, {
    provideTypeDefinition: (doc, pos) =>
      client
        .sendRequest(lsp.TypeDefinitionRequest.method, {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
        })
        .pipe(Effect.map((r) => toLocationResult(code, r))),
  });
});
