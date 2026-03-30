/**
 * Code action provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/codeAction.ts
 *
 * Key details:
 * - `providedCodeActionKinds` metadata built from server capabilities
 *   using `CodeActionKind.Empty.append()` for each dotted segment
 * - Optional `resolveProvider` for lazy edit resolution
 * - LSP `data` stashed via WeakMap for resolve round-trip
 * - Context conversion: `context.only` is a single CodeActionKind
 *   whose `.value` goes into an array for LSP `context.only`
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";
import {
  toCodeAction,
  toCodeActionKind,
  toLspCodeAction,
  toLspCodeActionContext,
  toLspRange,
  toWorkspaceEdit,
} from "./converters.ts";

export const registerCodeActionProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  const caps = client.serverInfo.capabilities.codeActionProvider;
  if (!caps) return;
  const code = yield* VsCode;

  const resolveProvider = typeof caps === "object" && caps.resolveProvider;
  const codeActionKinds =
    typeof caps === "object"
      ? caps.codeActionKinds?.map((k) => toCodeActionKind(code, k))
      : undefined;

  yield* code.languages.registerCodeActionsProvider(
    sel,
    {
      provideCodeActions: Effect.fn(function* (doc, range, ctx) {
        const result = yield* client.sendRequest(lsp.CodeActionRequest.method, {
          textDocument: { uri: doc.uri.toString() },
          range: toLspRange(range),
          context: toLspCodeActionContext(code, ctx),
        } satisfies lsp.CodeActionParams);
        if (!result) return [];
        return result
          .filter((a): a is lsp.CodeAction => !lsp.Command.is(a))
          .map((a) => toCodeAction(code, a));
      }),
      resolveCodeAction: resolveProvider
        ? Effect.fn(function* (item) {
            const resolved = yield* client.sendRequest(
              lsp.CodeActionResolveRequest.method,
              toLspCodeAction(code, item),
            );
            if (!resolved) return item;
            if (resolved.edit) item.edit = toWorkspaceEdit(code, resolved.edit);
            if (resolved.command) {
              item.command = {
                title: resolved.command.title,
                command: resolved.command.command,
                arguments: resolved.command.arguments,
              };
            }
            return item;
          })
        : undefined,
    },
    codeActionKinds ? { providedCodeActionKinds: codeActionKinds } : undefined,
  );
});
