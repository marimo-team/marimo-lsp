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
import { toDocumentHighlight, toDocumentPositionParams } from "./converters.ts";

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
