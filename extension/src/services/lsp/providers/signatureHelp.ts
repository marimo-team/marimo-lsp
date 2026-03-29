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

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";

function toDocumentation(
  code: VsCode,
  doc: string | lsp.MarkupContent | undefined,
): string | vscode.MarkdownString | undefined {
  if (!doc) return undefined;
  if (typeof doc === "string") return doc;
  return new code.MarkdownString(doc.value);
}

export function toSignatureHelp(
  code: VsCode,
  item: lsp.SignatureHelp,
): vscode.SignatureHelp {
  const result = new code.SignatureHelp();
  result.activeSignature = item.activeSignature ?? 0;
  result.activeParameter =
    item.activeParameter === null
      ? -1
      : (item.activeParameter ?? 0);
  result.signatures = (item.signatures ?? []).map((sig) => {
    const info = new code.SignatureInformation(
      sig.label,
      toDocumentation(code, sig.documentation),
    );
    info.parameters = (sig.parameters ?? []).map(
      (p) =>
        new code.ParameterInformation(
          p.label,
          toDocumentation(code, p.documentation),
        ),
    );
    if (sig.activeParameter !== undefined) {
      info.activeParameter = sig.activeParameter ?? -1;
    }
    return info;
  });
  return result;
}

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
