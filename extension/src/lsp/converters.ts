/**
 * Shared LSP → VS Code type converters used across providers.
 */

import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { VsCode } from "../platform/VsCode.ts";

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

// ---------------------------------------------------------------------------
// Document symbol converters
// ---------------------------------------------------------------------------

/**
 * LSP SymbolKind is 1-based, VS Code SymbolKind is 0-based.
 *
 * Reference: protocolConverter.ts asSymbolKind
 */
export function toSymbolKind(kind: lsp.SymbolKind): vscode.SymbolKind {
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

// ---------------------------------------------------------------------------
// Document highlight converters
// ---------------------------------------------------------------------------

/**
 * Reference: protocolConverter.ts asDocumentHighlightKind
 */
export function toDocumentHighlightKind(
  kind: lsp.DocumentHighlightKind,
): vscode.DocumentHighlightKind {
  switch (kind) {
    case lsp.DocumentHighlightKind.Text:
      return 0 satisfies typeof vscode.DocumentHighlightKind.Text;
    case lsp.DocumentHighlightKind.Read:
      return 1 satisfies typeof vscode.DocumentHighlightKind.Read;
    case lsp.DocumentHighlightKind.Write:
      return 2 satisfies typeof vscode.DocumentHighlightKind.Write;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function toDocumentHighlight(
  code: VsCode,
  item: lsp.DocumentHighlight,
): vscode.DocumentHighlight {
  return new code.DocumentHighlight(
    toVsCodeRange(code, item.range),
    item.kind != null ? toDocumentHighlightKind(item.kind) : undefined,
  );
}

// ---------------------------------------------------------------------------
// Hover converters
// ---------------------------------------------------------------------------

/**
 * Convert LSP hover contents to VS Code MarkdownString(s).
 *
 * Reference: protocolConverter.ts asHoverContent
 */
export function toHoverContent(
  code: VsCode,
  contents: lsp.Hover["contents"],
): vscode.MarkdownString | vscode.MarkdownString[] {
  if (typeof contents === "string") {
    return new code.MarkdownString(contents);
  }
  if ("kind" in contents) {
    return new code.MarkdownString(contents.value);
  }
  if (Array.isArray(contents)) {
    return contents.map((item) => {
      const md = new code.MarkdownString();
      if (typeof item === "string") {
        md.appendMarkdown(item);
      } else {
        md.appendCodeblock(item.value, item.language);
      }
      return md;
    });
  }
  const md = new code.MarkdownString();
  md.appendCodeblock(contents.value, contents.language);
  return md;
}

// ---------------------------------------------------------------------------
// Formatting converters
// ---------------------------------------------------------------------------

export function toTextEdit(code: VsCode, edit: lsp.TextEdit): vscode.TextEdit {
  return new code.TextEdit(toVsCodeRange(code, edit.range), edit.newText);
}

// ---------------------------------------------------------------------------
// Folding range converters
// ---------------------------------------------------------------------------

/**
 * Reference: protocolConverter.ts asFoldingRangeKind
 *
 * LSP and VS Code use the same string values for folding range kinds.
 */
export function toFoldingRange(
  code: VsCode,
  r: lsp.FoldingRange,
): vscode.FoldingRange {
  return new code.FoldingRange(
    r.startLine,
    r.endLine,
    r.kind ? toLspFoldingRangeKind(r.kind) : undefined,
  );
}

// ---------------------------------------------------------------------------
// Selection range converters
// ---------------------------------------------------------------------------

export function toSelectionRange(
  code: VsCode,
  sr: lsp.SelectionRange,
): vscode.SelectionRange {
  return new code.SelectionRange(
    toVsCodeRange(code, sr.range),
    sr.parent ? toSelectionRange(code, sr.parent) : undefined,
  );
}

// ---------------------------------------------------------------------------
// Signature help converters
// ---------------------------------------------------------------------------

export function toSignatureHelp(
  code: VsCode,
  item: lsp.SignatureHelp,
): vscode.SignatureHelp {
  const result = new code.SignatureHelp();
  result.activeSignature = item.activeSignature ?? 0;
  result.activeParameter =
    item.activeParameter === null ? -1 : (item.activeParameter ?? 0);
  result.signatures = (item.signatures ?? []).map((sig) => {
    const info = new code.SignatureInformation(
      sig.label,
      toDocumentation(code, sig.documentation),
    );
    info.parameters = (sig.parameters ?? []).map(
      (p) =>
        new code.ParameterInformation(
          p.label,
          toDocumentation(code, p.documentation),
        ),
    );
    if (sig.activeParameter !== undefined) {
      info.activeParameter = sig.activeParameter ?? -1;
    }
    return info;
  });
  return result;
}

// ---------------------------------------------------------------------------
// Inlay hint converters
// ---------------------------------------------------------------------------

export const inlayHintLspData = new WeakMap<vscode.InlayHint, unknown>();

export function toTooltip(
  code: VsCode,
  value: string | lsp.MarkupContent,
): string | vscode.MarkdownString {
  if (typeof value === "string") return value;
  return new code.MarkdownString(value.value);
}

export function toInlayHint(
  code: VsCode,
  item: lsp.InlayHint,
): vscode.InlayHint {
  const label =
    typeof item.label === "string"
      ? item.label
      : item.label.map((part) => {
          const lp = new code.InlayHintLabelPart(part.value);
          if (part.tooltip !== undefined)
            lp.tooltip = toTooltip(code, part.tooltip);
          if (part.location !== undefined) {
            lp.location = new code.Location(
              code.Uri.parse(part.location.uri),
              toVsCodeRange(code, part.location.range),
            );
          }
          if (part.command !== undefined) {
            lp.command = {
              title: part.command.title,
              command: part.command.command,
              arguments: part.command.arguments,
            };
          }
          return lp;
        });

  const result = new code.InlayHint(
    new code.Position(item.position.line, item.position.character),
    label,
    item.kind,
  );
  if (item.tooltip !== undefined)
    result.tooltip = toTooltip(code, item.tooltip);
  if (item.paddingLeft !== undefined) result.paddingLeft = item.paddingLeft;
  if (item.paddingRight !== undefined) result.paddingRight = item.paddingRight;

  if (item.data !== undefined) {
    inlayHintLspData.set(result, item.data);
  }
  return result;
}

export function toLspInlayHint(hint: vscode.InlayHint): lsp.InlayHint {
  const label =
    typeof hint.label === "string"
      ? hint.label
      : hint.label.map((part) => {
          const lp = lsp.InlayHintLabelPart.create(part.value);
          if (part.command !== undefined) {
            lp.command = {
              title: part.command.title,
              command: part.command.command,
              arguments: part.command.arguments,
            };
          }
          return lp;
        });

  const result = lsp.InlayHint.create(
    {
      line: hint.position.line,
      character: hint.position.character,
    },
    label,
  );
  if (hint.kind !== undefined) result.kind = hint.kind;
  if (hint.paddingLeft !== undefined) result.paddingLeft = hint.paddingLeft;
  if (hint.paddingRight !== undefined) result.paddingRight = hint.paddingRight;

  const data = inlayHintLspData.get(hint);
  if (data !== undefined) result.data = data;
  return result;
}

// ---------------------------------------------------------------------------
// Completion converters
// ---------------------------------------------------------------------------

export const completionLspData = new WeakMap<vscode.CompletionItem, unknown>();

export function toCompletionItem(
  code: VsCode,
  item: lsp.CompletionItem,
): vscode.CompletionItem {
  const label =
    item.labelDetails !== undefined
      ? {
          label: item.label,
          detail: item.labelDetails.detail,
          description: item.labelDetails.description,
        }
      : item.label;

  const result = new code.CompletionItem(label);

  if (item.kind !== undefined) {
    result.kind = toCompletionItemKind(code, item.kind);
  }
  if (item.detail) result.detail = item.detail;
  if (item.documentation) {
    result.documentation = toDocumentation(code, item.documentation);
  }
  if (item.filterText) result.filterText = item.filterText;
  if (item.sortText) result.sortText = item.sortText;
  if (item.preselect) result.preselect = item.preselect;

  // Insert text: prefer textEdit over insertText
  if (item.textEdit) {
    if (lsp.InsertReplaceEdit.is(item.textEdit)) {
      result.insertText = item.textEdit.newText;
      result.range = {
        inserting: toVsCodeRange(code, item.textEdit.insert),
        replacing: toVsCodeRange(code, item.textEdit.replace),
      };
    } else {
      result.insertText = item.textEdit.newText;
      result.range = toVsCodeRange(code, item.textEdit.range);
    }
  } else if (item.insertText) {
    result.insertText = item.insertText;
  }

  if (item.insertTextFormat === lsp.InsertTextFormat.Snippet) {
    result.insertText = new code.SnippetString(
      typeof result.insertText === "string"
        ? result.insertText
        : (item.insertText ?? item.label),
    );
  }

  if (item.additionalTextEdits) {
    result.additionalTextEdits = item.additionalTextEdits.map(
      (e) => new code.TextEdit(toVsCodeRange(code, e.range), e.newText),
    );
  }
  if (item.commitCharacters) {
    result.commitCharacters = item.commitCharacters.slice();
  }
  if (item.command) {
    result.command = {
      title: item.command.title,
      command: item.command.command,
      arguments: item.command.arguments,
    };
  }
  if (item.deprecated) {
    result.tags = [1 satisfies typeof vscode.CompletionItemTag.Deprecated];
  }
  if (item.tags) {
    result.tags = item.tags
      .filter((t) => t === lsp.CompletionItemTag.Deprecated)
      .map(() => 1 satisfies typeof vscode.CompletionItemTag.Deprecated);
  }

  if (item.data !== undefined) completionLspData.set(result, item.data);
  return result;
}

export function toLspCompletionItem(
  code: VsCode,
  item: vscode.CompletionItem,
): lsp.CompletionItem {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const result: lsp.CompletionItem = { label };

  if (item.kind !== undefined) {
    result.kind = toLspCompletionItemKind(code, item.kind);
  }
  if (item.detail) result.detail = item.detail;
  if (item.documentation) {
    result.documentation =
      typeof item.documentation === "string"
        ? item.documentation
        : item.documentation.value;
  }
  if (item.filterText) result.filterText = item.filterText;
  if (item.sortText) result.sortText = item.sortText;
  if (item.preselect) result.preselect = item.preselect;
  if (item.insertText) {
    result.insertText =
      typeof item.insertText === "string"
        ? item.insertText
        : item.insertText.value;
  }

  const data = completionLspData.get(item);
  if (data !== undefined) result.data = data;
  return result;
}

// ---------------------------------------------------------------------------
// Code action converters
// ---------------------------------------------------------------------------

export const codeActionLspData = new WeakMap<vscode.CodeAction, unknown>();

/**
 * Convert an LSP code action kind string to a VS Code CodeActionKind.
 *
 * Reference: protocolConverter.ts asCodeActionKind
 * Splits on "." and builds via CodeActionKind.Empty.append().
 */
export function toCodeActionKind(
  code: VsCode,
  kind: string,
): vscode.CodeActionKind {
  let result = code.CodeActionKind.Empty;
  for (const part of kind.split(".")) {
    result = result.append(part);
  }
  return result;
}

export function toLspCodeActionTriggerKind(
  code: VsCode,
  kind: vscode.CodeActionTriggerKind,
): lsp.CodeActionTriggerKind {
  switch (kind) {
    case code.CodeActionTriggerKind.Invoke:
      return lsp.CodeActionTriggerKind.Invoked;
    case code.CodeActionTriggerKind.Automatic:
      return lsp.CodeActionTriggerKind.Automatic;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

export function toLspCodeActionContext(
  code: VsCode,
  ctx: vscode.CodeActionContext,
): lsp.CodeActionContext {
  // Reference: codeConverter.ts asCodeActionContextSync
  // context.only is a single CodeActionKind — extract .value as string
  let only: lsp.CodeActionKind[] | undefined;
  if (ctx.only && typeof ctx.only.value === "string") {
    only = [ctx.only.value];
  }
  return lsp.CodeActionContext.create(
    ctx.diagnostics.map((d) => toLspDiagnostic(code, d)),
    only,
    toLspCodeActionTriggerKind(code, ctx.triggerKind),
  );
}

export function toCodeAction(
  code: VsCode,
  item: lsp.CodeAction,
): vscode.CodeAction {
  const result = new code.CodeAction(item.title);
  if (item.kind !== undefined) result.kind = toCodeActionKind(code, item.kind);
  if (item.edit !== undefined) result.edit = toWorkspaceEdit(code, item.edit);
  if (item.command !== undefined) {
    result.command = {
      title: item.command.title,
      command: item.command.command,
      arguments: item.command.arguments,
    };
  }
  if (item.isPreferred !== undefined) result.isPreferred = item.isPreferred;
  if (item.disabled !== undefined) {
    result.disabled = { reason: item.disabled.reason };
  }
  if (item.diagnostics !== undefined) {
    result.diagnostics = item.diagnostics.map((d) => {
      const diag = new code.Diagnostic(
        toVsCodeRange(code, d.range),
        d.message,
        d.severity != null
          ? toVsCodeDiagnosticSeverity(code, d.severity)
          : undefined,
      );
      if (d.source) diag.source = d.source;
      if (d.code != null) {
        diag.code =
          typeof d.code === "string" || typeof d.code === "number"
            ? d.code
            : undefined;
      }
      return diag;
    });
  }
  if (item.data !== undefined) codeActionLspData.set(result, item.data);
  return result;
}

export function toLspCodeAction(
  code: VsCode,
  item: vscode.CodeAction,
): lsp.CodeAction {
  // Reference: codeConverter.ts asCodeActionSync
  const result = lsp.CodeAction.create(item.title);
  const data = codeActionLspData.get(item);
  if (data !== undefined) result.data = data;
  if (item.kind !== undefined) result.kind = item.kind.value;
  if (item.diagnostics !== undefined) {
    result.diagnostics = item.diagnostics.map((d) => toLspDiagnostic(code, d));
  }
  if (item.command !== undefined) {
    result.command = {
      title: item.command.title,
      command: item.command.command,
      arguments: item.command.arguments,
    };
  }
  if (item.isPreferred !== undefined) result.isPreferred = item.isPreferred;
  if (item.disabled !== undefined) {
    result.disabled = { reason: item.disabled.reason };
  }
  return result;
}
