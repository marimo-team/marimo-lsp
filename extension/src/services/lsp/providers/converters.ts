/**
 * Shared LSP → VS Code type converters used across providers.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { LspRequestError } from "../../../utils/makeMarimoLspClient.ts";
import type { VsCode } from "../../VsCode.ts";

/**
 * Catch an {@link LspRequestError} and return a fallback value.
 *
 * Used in provider callbacks so that a server error (e.g. MethodNotFound,
 * connection lost) returns empty results instead of crashing the fiber.
 */
export function catchLspError<T>(fallback: T) {
  return <A>(self: Effect.Effect<A, LspRequestError>) =>
    self.pipe(
      Effect.catchTag("LspRequestError", (err) =>
        Effect.logDebug("LSP request failed").pipe(
          Effect.annotateLogs({ method: err.method, code: err.code }),
          Effect.as(fallback),
        ),
      ),
    );
}

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
