/**
 * References provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/reference.ts
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";
import { catchLspError, toLocation } from "./converters.ts";

export const registerReferenceProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.referencesProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerReferenceProvider(sel, {
    provideReferences: Effect.fn(function* (doc, pos, ctx) {
      const result = yield* client
        .sendRequest(lsp.ReferencesRequest.method, {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
          context: { includeDeclaration: ctx.includeDeclaration },
        } satisfies lsp.ReferenceParams)
        .pipe(catchLspError(null));
      return result?.map((l) => toLocation(code, l)) ?? [];
    }),
  });
});
