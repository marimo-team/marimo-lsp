/**
 * Signature help provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/signatureHelp.ts
 *
 * Passes trigger/retrigger characters from server capabilities as metadata.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toSignatureHelp } from "../converters.ts";

export const registerSignatureHelpProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  const caps = client.serverInfo.capabilities.signatureHelpProvider;
  if (!caps) return;
  const code = yield* VsCode;

  const triggerCharacters = caps.triggerCharacters ?? [];
  const retriggerCharacters = caps.retriggerCharacters;

  yield* code.languages.registerSignatureHelpProvider(
    sel,
    {
      provideSignatureHelp: Effect.fn(function* (doc, pos) {
        const result = yield* client.sendRequest(
          lsp.SignatureHelpRequest.method,
          {
            textDocument: { uri: doc.uri.toString() },
            position: { line: pos.line, character: pos.character },
          },
        );
        if (!result) return undefined;
        return toSignatureHelp(code, result);
      }),
    },
    retriggerCharacters !== undefined
      ? { triggerCharacters, retriggerCharacters: retriggerCharacters ?? [] }
      : triggerCharacters,
  );
});
