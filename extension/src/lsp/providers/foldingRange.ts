/**
 * Folding range provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/foldingRange.ts
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toFoldingRange } from "../converters.ts";

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
