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

export function toVsCodeDiagnosticSeverity(
  code: VsCode,
  severity: lsp.DiagnosticSeverity,
): vscode.DiagnosticSeverity {
  switch (severity) {
    case lsp.DiagnosticSeverity.Error:
      return code.DiagnosticSeverity.Error;
    case lsp.DiagnosticSeverity.Warning:
      return code.DiagnosticSeverity.Warning;
    case lsp.DiagnosticSeverity.Information:
      return code.DiagnosticSeverity.Information;
    case lsp.DiagnosticSeverity.Hint:
      return code.DiagnosticSeverity.Hint;
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}

export function toLspPosition(pos: vscode.Position): lsp.Position {
  return { line: pos.line, character: pos.character };
}

export function toLspRange(range: vscode.Range): lsp.Range {
  return {
    start: { line: range.start.line, character: range.start.character },
    end: { line: range.end.line, character: range.end.character },
  };
}

export function toLspDiagnosticSeverity(
  code: VsCode,
  severity: vscode.DiagnosticSeverity,
): lsp.DiagnosticSeverity {
  switch (severity) {
    case code.DiagnosticSeverity.Error:
      return lsp.DiagnosticSeverity.Error;
    case code.DiagnosticSeverity.Warning:
      return lsp.DiagnosticSeverity.Warning;
    case code.DiagnosticSeverity.Information:
      return lsp.DiagnosticSeverity.Information;
    case code.DiagnosticSeverity.Hint:
      return lsp.DiagnosticSeverity.Hint;
    default: {
      const _exhaustive: never = severity;
      return _exhaustive;
    }
  }
}

export function toLspDiagnostic(
  code: VsCode,
  d: vscode.Diagnostic,
): lsp.Diagnostic {
  return {
    range: toLspRange(d.range),
    message: d.message,
    severity:
      d.severity != null
        ? toLspDiagnosticSeverity(code, d.severity)
        : undefined,
    code: typeof d.code === "object" && d.code != null ? d.code.value : d.code,
    source: d.source,
  };
}

export function toDocumentation(
  code: VsCode,
  doc: string | lsp.MarkupContent | undefined,
): string | vscode.MarkdownString | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return doc;
  return new code.MarkdownString(doc.value);
}

export function toWorkspaceEdit(
  code: VsCode,
  edit: lsp.WorkspaceEdit,
): vscode.WorkspaceEdit {
  const ws = new code.WorkspaceEdit();
  if (edit.changes) {
    for (const [uri, edits] of Object.entries(edit.changes)) {
      ws.set(
        code.Uri.parse(uri),
        edits.map(
          (e) => new code.TextEdit(toVsCodeRange(code, e.range), e.newText),
        ),
      );
    }
  }
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      if ("textDocument" in change) {
        ws.set(
          code.Uri.parse(change.textDocument.uri),
          change.edits
            .filter((e): e is lsp.TextEdit => "range" in e)
            .map(
              (e) => new code.TextEdit(toVsCodeRange(code, e.range), e.newText),
            ),
        );
      }
    }
  }
  return ws;
}

export function toCompletionItemKind(
  code: VsCode,
  value: lsp.CompletionItemKind,
): vscode.CompletionItemKind {
  switch (value) {
    case lsp.CompletionItemKind.Text:
      return code.CompletionItemKind.Text;
    case lsp.CompletionItemKind.Method:
      return code.CompletionItemKind.Method;
    case lsp.CompletionItemKind.Function:
      return code.CompletionItemKind.Function;
    case lsp.CompletionItemKind.Constructor:
      return code.CompletionItemKind.Constructor;
    case lsp.CompletionItemKind.Field:
      return code.CompletionItemKind.Field;
    case lsp.CompletionItemKind.Variable:
      return code.CompletionItemKind.Variable;
    case lsp.CompletionItemKind.Class:
      return code.CompletionItemKind.Class;
    case lsp.CompletionItemKind.Interface:
      return code.CompletionItemKind.Interface;
    case lsp.CompletionItemKind.Module:
      return code.CompletionItemKind.Module;
    case lsp.CompletionItemKind.Property:
      return code.CompletionItemKind.Property;
    case lsp.CompletionItemKind.Unit:
      return code.CompletionItemKind.Unit;
    case lsp.CompletionItemKind.Value:
      return code.CompletionItemKind.Value;
    case lsp.CompletionItemKind.Enum:
      return code.CompletionItemKind.Enum;
    case lsp.CompletionItemKind.Keyword:
      return code.CompletionItemKind.Keyword;
    case lsp.CompletionItemKind.Snippet:
      return code.CompletionItemKind.Snippet;
    case lsp.CompletionItemKind.Color:
      return code.CompletionItemKind.Color;
    case lsp.CompletionItemKind.File:
      return code.CompletionItemKind.File;
    case lsp.CompletionItemKind.Reference:
      return code.CompletionItemKind.Reference;
    case lsp.CompletionItemKind.Folder:
      return code.CompletionItemKind.Folder;
    case lsp.CompletionItemKind.EnumMember:
      return code.CompletionItemKind.EnumMember;
    case lsp.CompletionItemKind.Constant:
      return code.CompletionItemKind.Constant;
    case lsp.CompletionItemKind.Struct:
      return code.CompletionItemKind.Struct;
    case lsp.CompletionItemKind.Event:
      return code.CompletionItemKind.Event;
    case lsp.CompletionItemKind.Operator:
      return code.CompletionItemKind.Operator;
    case lsp.CompletionItemKind.TypeParameter:
      return code.CompletionItemKind.TypeParameter;
    default: {
      const _exhaustive: never = value;
      return _exhaustive;
    }
  }
}

export function toLspCompletionItemKind(
  code: VsCode,
  kind: vscode.CompletionItemKind,
): lsp.CompletionItemKind {
  switch (kind) {
    case code.CompletionItemKind.Text:
      return lsp.CompletionItemKind.Text;
    case code.CompletionItemKind.Method:
      return lsp.CompletionItemKind.Method;
    case code.CompletionItemKind.Function:
      return lsp.CompletionItemKind.Function;
    case code.CompletionItemKind.Constructor:
      return lsp.CompletionItemKind.Constructor;
    case code.CompletionItemKind.Field:
      return lsp.CompletionItemKind.Field;
    case code.CompletionItemKind.Variable:
      return lsp.CompletionItemKind.Variable;
    case code.CompletionItemKind.Class:
      return lsp.CompletionItemKind.Class;
    case code.CompletionItemKind.Interface:
      return lsp.CompletionItemKind.Interface;
    case code.CompletionItemKind.Module:
      return lsp.CompletionItemKind.Module;
    case code.CompletionItemKind.Property:
      return lsp.CompletionItemKind.Property;
    case code.CompletionItemKind.Unit:
      return lsp.CompletionItemKind.Unit;
    case code.CompletionItemKind.Value:
      return lsp.CompletionItemKind.Value;
    case code.CompletionItemKind.Enum:
      return lsp.CompletionItemKind.Enum;
    case code.CompletionItemKind.Keyword:
      return lsp.CompletionItemKind.Keyword;
    case code.CompletionItemKind.Snippet:
      return lsp.CompletionItemKind.Snippet;
    case code.CompletionItemKind.Color:
      return lsp.CompletionItemKind.Color;
    case code.CompletionItemKind.File:
      return lsp.CompletionItemKind.File;
    case code.CompletionItemKind.Reference:
      return lsp.CompletionItemKind.Reference;
    case code.CompletionItemKind.Folder:
      return lsp.CompletionItemKind.Folder;
    case code.CompletionItemKind.EnumMember:
      return lsp.CompletionItemKind.EnumMember;
    case code.CompletionItemKind.Constant:
      return lsp.CompletionItemKind.Constant;
    case code.CompletionItemKind.Struct:
      return lsp.CompletionItemKind.Struct;
    case code.CompletionItemKind.Event:
      return lsp.CompletionItemKind.Event;
    case code.CompletionItemKind.Operator:
      return lsp.CompletionItemKind.Operator;
    case code.CompletionItemKind.TypeParameter:
      return lsp.CompletionItemKind.TypeParameter;
    // VS Code-only kinds with no LSP equivalent
    case code.CompletionItemKind.User:
    case code.CompletionItemKind.Issue:
      return lsp.CompletionItemKind.Text;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function toLspCompletionTriggerKind(
  code: VsCode,
  kind: vscode.CompletionTriggerKind,
): lsp.CompletionTriggerKind {
  switch (kind) {
    case code.CompletionTriggerKind.Invoke:
      return lsp.CompletionTriggerKind.Invoked;
    case code.CompletionTriggerKind.TriggerCharacter:
      return lsp.CompletionTriggerKind.TriggerCharacter;
    case code.CompletionTriggerKind.TriggerForIncompleteCompletions:
      return lsp.CompletionTriggerKind.TriggerForIncompleteCompletions;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

// Not exhaustive: LSP FoldingRangeKind is `string`, extensible by servers.
// Unknown kinds get no VS Code FoldingRangeKind (renders as generic fold).
export function toLspFoldingRangeKind(
  kind: lsp.FoldingRangeKind,
): vscode.FoldingRangeKind | undefined {
  switch (kind) {
    case lsp.FoldingRangeKind.Comment:
      return 1 satisfies typeof vscode.FoldingRangeKind.Comment;
    case lsp.FoldingRangeKind.Imports:
      return 2 satisfies typeof vscode.FoldingRangeKind.Imports;
    case lsp.FoldingRangeKind.Region:
      return 3 satisfies typeof vscode.FoldingRangeKind.Region;
    default:
      return undefined;
  }
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
