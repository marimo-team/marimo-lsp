/**
 * Folding range provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/foldingRange.ts
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";

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
    r.kind as unknown as vscode.FoldingRangeKind | undefined,
  );
}

export const registerFoldingRangeProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.foldingRangeProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerFoldingRangeProvider(sel, {
    provideFoldingRanges: Effect.fn(function* (doc) {
      const result = yield* client.sendRequest(lsp.FoldingRangeRequest.method, {
        textDocument: { uri: doc.uri.toString() },
      });
      return result?.map((f) => toFoldingRange(code, f)) ?? [];
    }),
  });
});
