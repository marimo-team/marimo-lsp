/**
 * Shared LSP → VS Code type converters used across providers.
 */

import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { VsCode } from "../../VsCode.ts";

export function toVsCodeRange(code: VsCode, range: lsp.Range): vscode.Range {
  return new code.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

export function toLocation(code: VsCode, loc: lsp.Location): vscode.Location {
  return new code.Location(
    code.Uri.parse(loc.uri),
    toVsCodeRange(code, loc.range),
  );
}

export function toLocationLink(
  code: VsCode,
  link: lsp.LocationLink,
): vscode.LocationLink {
  return {
    targetUri: code.Uri.parse(link.targetUri),
    targetRange: toVsCodeRange(code, link.targetRange),
    targetSelectionRange: toVsCodeRange(code, link.targetSelectionRange),
    originSelectionRange: link.originSelectionRange
      ? toVsCodeRange(code, link.originSelectionRange)
      : undefined,
  };
}

/**
 * Convert LSP definition/declaration result to VS Code types.
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

export function toDocumentPositionParams(
  doc: vscode.TextDocument,
  pos: vscode.Position,
): lsp.TextDocumentPositionParams {
  return {
    textDocument: { uri: doc.uri.toString() },
    position: { line: pos.line, character: pos.character },
  };
}
