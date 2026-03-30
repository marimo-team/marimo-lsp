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

import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toInlayHint, toLspInlayHint, toLspRange } from "../converters.ts";

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
      });
      return result?.map((h) => toInlayHint(code, h)) ?? [];
    }),
    resolveInlayHint: resolveProvider
      ? Effect.fn(function* (hint) {
          const resolved = yield* client.sendRequest(
            lsp.InlayHintResolveRequest.method,
            toLspInlayHint(hint),
          );
          return resolved ? toInlayHint(code, resolved) : hint;
        })
      : undefined,
  });
});
