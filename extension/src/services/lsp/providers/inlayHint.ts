/**
 * Inlay hint provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/inlayHint.ts
 *
 * Supports optional resolveProvider for lazy tooltip/textEdit resolution.
 * LSP `data` is stashed on the InlayHint via a symbol key for the
 * resolve round-trip.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";
import { toLspRange, toVsCodeRange } from "./converters.ts";

// ---------------------------------------------------------------------------
// Data stashing for resolve round-trip
// ---------------------------------------------------------------------------

const lspData = new WeakMap<vscode.InlayHint, unknown>();

// ---------------------------------------------------------------------------
// LSP → VS Code converters
// ---------------------------------------------------------------------------

function toTooltip(
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
    lspData.set(result, item.data);
  }
  return result;
}

// ---------------------------------------------------------------------------
// VS Code → LSP converter (for resolve)
// ---------------------------------------------------------------------------

function toLspInlayHint(hint: vscode.InlayHint): lsp.InlayHint {
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

  const data = lspData.get(hint);
  if (data !== undefined) result.data = data;
  return result;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerInlayHintProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  const caps = client.serverInfo.capabilities.inlayHintProvider;
  if (!caps) return;
  const code = yield* VsCode;

  const resolveProvider = typeof caps === "object" && caps.resolveProvider;

  yield* code.languages.registerInlayHintsProvider(sel, {
    provideInlayHints: Effect.fn(function* (doc, range) {
      const result = yield* client.sendRequest(lsp.InlayHintRequest.method, {
        textDocument: { uri: doc.uri.toString() },
        range: toLspRange(range),
      } satisfies lsp.InlayHintParams);
      return result?.map((h) => toInlayHint(code, h)) ?? [];
    }),
    resolveInlayHint: resolveProvider
      ? Effect.fn(function* (hint) {
          const resolved = yield* client.sendRequest(
            lsp.InlayHintResolveRequest.method,
            toLspInlayHint(hint),
          );
          return toInlayHint(code, resolved);
        })
      : undefined,
  });
});
