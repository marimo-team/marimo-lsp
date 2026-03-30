/**
 * Semantic tokens provider registration (full + range).
 *
 * Reference: vscode-languageserver-node/client/src/common/semanticTokens.ts
 *
 * Registers up to two providers based on server capabilities:
 * - Full document semantic tokens (if `full` is truthy)
 * - Range semantic tokens (if `range` is true)
 *
 * Both share the same legend built from the server's capability options.
 * Delta support is not implemented (neither Ruff nor ty use it).
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toLspRange } from "../converters.ts";

export const registerSemanticTokensProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  const caps = client.serverInfo.capabilities.semanticTokensProvider;
  if (!caps) return;
  const code = yield* VsCode;

  const legend = new code.SemanticTokensLegend(
    caps.legend.tokenTypes,
    caps.legend.tokenModifiers,
  );

  const hasFull =
    typeof caps.full === "boolean" ? caps.full : caps.full !== undefined;
  const hasRange = caps.range === true;

  if (hasFull) {
    yield* code.languages.registerDocumentSemanticTokensProvider(
      sel,
      {
        provideDocumentSemanticTokens: Effect.fn(function* (doc) {
          const result = yield* client.sendRequest(
            lsp.SemanticTokensRequest.method,
            {
              textDocument: { uri: doc.uri.toString() },
            } satisfies lsp.SemanticTokensParams,
          );
          if (!result) return undefined;
          return new code.SemanticTokens(
            new Uint32Array(result.data),
            result.resultId,
          );
        }),
      },
      legend,
    );
  }

  if (hasRange) {
    yield* code.languages.registerDocumentRangeSemanticTokensProvider(
      sel,
      {
        provideDocumentRangeSemanticTokens: Effect.fn(function* (doc, range) {
          const result = yield* client.sendRequest(
            lsp.SemanticTokensRangeRequest.method,
            {
              textDocument: { uri: doc.uri.toString() },
              range: toLspRange(range),
            } satisfies lsp.SemanticTokensRangeParams,
          );
          if (!result) return undefined;
          return new code.SemanticTokens(
            new Uint32Array(result.data),
            result.resultId,
          );
        }),
      },
      legend,
    );
  }
});
