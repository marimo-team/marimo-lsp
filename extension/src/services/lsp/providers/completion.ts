/**
 * Completion provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/completion.ts
 *
 * Supports trigger characters and optional resolveProvider.
 * CompletionItemKind is 1-based in LSP, 0-based in VS Code.
 * LSP `data` is stashed for the resolve round-trip.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import {
  toCompletionItem,
  toLspCompletionItem,
  toLspCompletionTriggerKind,
} from "../converters.ts";

export const registerCompletionProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  const caps = client.serverInfo.capabilities.completionProvider;
  if (!caps) return;
  const code = yield* VsCode;

  const triggerCharacters = caps.triggerCharacters ?? [];
  const resolveProvider = caps.resolveProvider;

  yield* code.languages.registerCompletionItemProvider(
    sel,
    {
      provideCompletionItems: Effect.fn(function* (doc, pos, ctx) {
        const result = yield* client.sendRequest(lsp.CompletionRequest.method, {
          textDocument: { uri: doc.uri.toString() },
          position: { line: pos.line, character: pos.character },
          context: {
            triggerKind: toLspCompletionTriggerKind(code, ctx.triggerKind),
            triggerCharacter: ctx.triggerCharacter,
          },
        } satisfies lsp.CompletionParams);
        if (!result) return [];
        return result.items.map((item) => toCompletionItem(code, item));
      }),
      resolveCompletionItem: resolveProvider
        ? Effect.fn(function* (item) {
            const resolved = yield* client.sendRequest(
              lsp.CompletionResolveRequest.method,
              toLspCompletionItem(code, item),
            );
            return resolved ? toCompletionItem(code, resolved) : item;
          })
        : undefined,
    },
    triggerCharacters,
  );
});
