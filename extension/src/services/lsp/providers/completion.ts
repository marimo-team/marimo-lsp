/**
 * Completion provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/completion.ts
 *
 * Supports trigger characters and optional resolveProvider.
 * CompletionItemKind is 1-based in LSP, 0-based in VS Code.
 * LSP `data` is stashed for the resolve round-trip.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";
import { toDocumentation, toVsCodeRange } from "./converters.ts";

// ---------------------------------------------------------------------------
// Data stashing for resolve round-trip
// ---------------------------------------------------------------------------

const lspData = new WeakMap<vscode.CompletionItem, unknown>();

// ---------------------------------------------------------------------------
// LSP → VS Code converters
// ---------------------------------------------------------------------------

/**
 * CompletionItemKind: LSP is 1-based, VS Code is 0-based.
 *
 * Reference: protocolConverter.ts asCompletionItemKind
 */
function toCompletionItemKind(
  value: lsp.CompletionItemKind,
): vscode.CompletionItemKind {
  if (
    lsp.CompletionItemKind.Text <= value &&
    value <= lsp.CompletionItemKind.TypeParameter
  ) {
    return (value - 1) as vscode.CompletionItemKind;
  }
  return 0 satisfies typeof vscode.CompletionItemKind.Text;
}

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
    result.kind = toCompletionItemKind(item.kind);
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

  if (item.data !== undefined) lspData.set(result, item.data);
  return result;
}

// ---------------------------------------------------------------------------
// VS Code → LSP converter (for resolve)
// ---------------------------------------------------------------------------

function toLspCompletionItem(item: vscode.CompletionItem): lsp.CompletionItem {
  const label = typeof item.label === "string" ? item.label : item.label.label;
  const result: lsp.CompletionItem = { label };

  if (item.kind !== undefined) {
    // VS Code 0-based → LSP 1-based
    result.kind = (item.kind + 1) as lsp.CompletionItemKind;
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

  const data = lspData.get(item);
  if (data !== undefined) result.data = data;
  return result;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerCompletionProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  const caps = client.serverInfo.capabilities.completionProvider;
  if (!caps) return;
  const code = yield* VsCode;

  const triggerCharacters = caps.triggerCharacters ?? [];
  const resolveProvider = caps.resolveProvider;

  yield* code.languages.registerCompletionItemProvider(
    sel,
    {
      provideCompletionItems: Effect.fn(function* (doc, pos, ctx) {
        const result = yield* client.sendRequest(lsp.CompletionRequest.method, {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
          context: {
            triggerKind: (ctx.triggerKind + 1) as lsp.CompletionTriggerKind,
            triggerCharacter: ctx.triggerCharacter,
          },
        } satisfies lsp.CompletionParams);
        if (!result) return [];
        return result.items.map((item) => toCompletionItem(code, item));
      }),
      resolveCompletionItem: resolveProvider
        ? Effect.fn(function* (item) {
            const resolved = yield* client.sendRequest(
              lsp.CompletionResolveRequest.method,
              toLspCompletionItem(item),
            );
            return toCompletionItem(code, resolved);
          })
        : undefined,
    },
    triggerCharacters,
  );
});
