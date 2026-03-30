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

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";
import { catchLspError, toVsCodeRange } from "./converters.ts";

/**
 * LSP SymbolKind is 1-based, VS Code SymbolKind is 0-based.
 *
 * Reference: protocolConverter.ts asSymbolKind
 */
function toSymbolKind(kind: lsp.SymbolKind): vscode.SymbolKind {
  switch (kind) {
    case lsp.SymbolKind.File:
      return 0 satisfies vscode.SymbolKind.File;
    case lsp.SymbolKind.Module:
      return 1 satisfies vscode.SymbolKind.Module;
    case lsp.SymbolKind.Namespace:
      return 2 satisfies vscode.SymbolKind.Namespace;
    case lsp.SymbolKind.Package:
      return 3 satisfies vscode.SymbolKind.Package;
    case lsp.SymbolKind.Class:
      return 4 satisfies vscode.SymbolKind.Class;
    case lsp.SymbolKind.Method:
      return 5 satisfies vscode.SymbolKind.Method;
    case lsp.SymbolKind.Property:
      return 6 satisfies vscode.SymbolKind.Property;
    case lsp.SymbolKind.Field:
      return 7 satisfies vscode.SymbolKind.Field;
    case lsp.SymbolKind.Constructor:
      return 8 satisfies vscode.SymbolKind.Constructor;
    case lsp.SymbolKind.Enum:
      return 9 satisfies vscode.SymbolKind.Enum;
    case lsp.SymbolKind.Interface:
      return 10 satisfies vscode.SymbolKind.Interface;
    case lsp.SymbolKind.Function:
      return 11 satisfies vscode.SymbolKind.Function;
    case lsp.SymbolKind.Variable:
      return 12 satisfies vscode.SymbolKind.Variable;
    case lsp.SymbolKind.Constant:
      return 13 satisfies vscode.SymbolKind.Constant;
    case lsp.SymbolKind.String:
      return 14 satisfies vscode.SymbolKind.String;
    case lsp.SymbolKind.Number:
      return 15 satisfies vscode.SymbolKind.Number;
    case lsp.SymbolKind.Boolean:
      return 16 satisfies vscode.SymbolKind.Boolean;
    case lsp.SymbolKind.Array:
      return 17 satisfies vscode.SymbolKind.Array;
    case lsp.SymbolKind.Object:
      return 18 satisfies vscode.SymbolKind.Object;
    case lsp.SymbolKind.Key:
      return 19 satisfies vscode.SymbolKind.Key;
    case lsp.SymbolKind.Null:
      return 20 satisfies vscode.SymbolKind.Null;
    case lsp.SymbolKind.EnumMember:
      return 21 satisfies vscode.SymbolKind.EnumMember;
    case lsp.SymbolKind.Struct:
      return 22 satisfies vscode.SymbolKind.Struct;
    case lsp.SymbolKind.Event:
      return 23 satisfies vscode.SymbolKind.Event;
    case lsp.SymbolKind.Operator:
      return 24 satisfies vscode.SymbolKind.Operator;
    case lsp.SymbolKind.TypeParameter:
      return 25 satisfies vscode.SymbolKind.TypeParameter;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function toDocumentSymbol(
  code: VsCode,
  sym: lsp.DocumentSymbol,
): vscode.DocumentSymbol {
  const result = new code.DocumentSymbol(
    sym.name,
    sym.detail ?? "",
    toSymbolKind(sym.kind),
    toVsCodeRange(code, sym.range),
    toVsCodeRange(code, sym.selectionRange),
  );
  if (sym.children && sym.children.length > 0) {
    result.children = sym.children.map((c) => toDocumentSymbol(code, c));
  }
  if (sym.tags) {
    result.tags = sym.tags;
  }
  return result;
}

export const registerDocumentSymbolProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.documentSymbolProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDocumentSymbolProvider(sel, {
    provideDocumentSymbols: Effect.fn(function* (doc) {
      const result = yield* client
        .sendRequest(lsp.DocumentSymbolRequest.method, {
          textDocument: { uri: doc.uri.toString() },
        })
        .pipe(catchLspError(null));
      return result?.map((s) => toDocumentSymbol(code, s)) ?? [];
    }),
  });
});
