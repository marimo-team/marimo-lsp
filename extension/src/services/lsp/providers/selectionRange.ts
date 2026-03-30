/**
 * Selection range provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/selectionRange.ts
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toSelectionRange } from "../converters.ts";

export const registerSelectionRangeProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.selectionRangeProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerSelectionRangeProvider(sel, {
    provideSelectionRanges: Effect.fn(function* (doc, positions) {
      const result = yield* client.sendRequest(
        lsp.SelectionRangeRequest.method,
        {
          textDocument: { uri: doc.uri.toString() },
          positions: positions.map((p) => ({
            line: p.line,
            character: p.character,
          })),
        },
      );
      return result?.map((s) => toSelectionRange(code, s)) ?? [];
    }),
  });
});
