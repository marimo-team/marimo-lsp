/**
 * Document highlight provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/documentHighlight.ts
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";
import { toDocumentPositionParams, toVsCodeRange } from "./converters.ts";

/**
 * Reference: protocolConverter.ts asDocumentHighlightKind
 */
function toDocumentHighlightKind(
  kind: lsp.DocumentHighlightKind,
): vscode.DocumentHighlightKind {
  switch (kind) {
    case lsp.DocumentHighlightKind.Text:
      return 0 satisfies typeof vscode.DocumentHighlightKind.Text;
    case lsp.DocumentHighlightKind.Read:
      return 1 satisfies typeof vscode.DocumentHighlightKind.Read;
    case lsp.DocumentHighlightKind.Write:
      return 2 satisfies typeof vscode.DocumentHighlightKind.Write;
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

export const registerDocumentHighlightProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.documentHighlightProvider) {
    return;
  }
  const code = yield* VsCode;

  yield* code.languages.registerDocumentHighlightProvider(sel, {
    provideDocumentHighlights: Effect.fn(function* (doc, pos) {
      const result = yield* client.sendRequest(
        lsp.DocumentHighlightRequest.method,
        toDocumentPositionParams(doc, pos),
      );
      return result?.map((h) => toDocumentHighlight(code, h)) ?? [];
    }),
  });
});
