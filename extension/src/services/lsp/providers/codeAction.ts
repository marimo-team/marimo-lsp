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
  toLspDiagnostic,
  toLspRange,
  toVsCodeDiagnosticSeverity,
  toVsCodeRange,
  toWorkspaceEdit,
} from "./converters.ts";

// ---------------------------------------------------------------------------
// Data stashing for resolve round-trip
// ---------------------------------------------------------------------------

const lspData = new WeakMap<vscode.CodeAction, unknown>();

// ---------------------------------------------------------------------------
// Kind conversion
// ---------------------------------------------------------------------------

/**
 * Convert an LSP code action kind string to a VS Code CodeActionKind.
 *
 * Reference: protocolConverter.ts asCodeActionKind
 * Splits on "." and builds via CodeActionKind.Empty.append().
 */
export function toCodeActionKind(
  code: VsCode,
  kind: string,
): vscode.CodeActionKind {
  let result = code.CodeActionKind.Empty;
  for (const part of kind.split(".")) {
    result = result.append(part);
  }
  return result;
}

// ---------------------------------------------------------------------------
// LSP → VS Code converters
// ---------------------------------------------------------------------------

function toLspCodeActionTriggerKind(
  code: VsCode,
  kind: vscode.CodeActionTriggerKind,
): lsp.CodeActionTriggerKind {
  switch (kind) {
    case code.CodeActionTriggerKind.Invoke:
      return lsp.CodeActionTriggerKind.Invoked;
    case code.CodeActionTriggerKind.Automatic:
      return lsp.CodeActionTriggerKind.Automatic;
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function toLspCodeActionContext(
  code: VsCode,
  ctx: vscode.CodeActionContext,
): lsp.CodeActionContext {
  // Reference: codeConverter.ts asCodeActionContextSync
  // context.only is a single CodeActionKind — extract .value as string
  let only: lsp.CodeActionKind[] | undefined;
  if (ctx.only && typeof ctx.only.value === "string") {
    only = [ctx.only.value];
  }
  return lsp.CodeActionContext.create(
    ctx.diagnostics.map((d) => toLspDiagnostic(code, d)),
    only,
    toLspCodeActionTriggerKind(code, ctx.triggerKind),
  );
}

export function toCodeAction(
  code: VsCode,
  item: lsp.CodeAction,
): vscode.CodeAction {
  const result = new code.CodeAction(item.title);
  if (item.kind !== undefined) result.kind = toCodeActionKind(code, item.kind);
  if (item.edit !== undefined) result.edit = toWorkspaceEdit(code, item.edit);
  if (item.command !== undefined) {
    result.command = {
      title: item.command.title,
      command: item.command.command,
      arguments: item.command.arguments,
    };
  }
  if (item.isPreferred !== undefined) result.isPreferred = item.isPreferred;
  if (item.disabled !== undefined) {
    result.disabled = { reason: item.disabled.reason };
  }
  if (item.diagnostics !== undefined) {
    result.diagnostics = item.diagnostics.map((d) => {
      const diag = new code.Diagnostic(
        toVsCodeRange(code, d.range),
        d.message,
        d.severity != null
          ? toVsCodeDiagnosticSeverity(code, d.severity)
          : undefined,
      );
      if (d.source) diag.source = d.source;
      if (d.code != null) {
        diag.code =
          typeof d.code === "string" || typeof d.code === "number"
            ? d.code
            : undefined;
      }
      return diag;
    });
  }
  if (item.data !== undefined) lspData.set(result, item.data);
  return result;
}

// ---------------------------------------------------------------------------
// VS Code → LSP converter (for resolve)
// ---------------------------------------------------------------------------

function toLspCodeAction(
  code: VsCode,
  item: vscode.CodeAction,
): lsp.CodeAction {
  // Reference: codeConverter.ts asCodeActionSync
  const result = lsp.CodeAction.create(item.title);
  const data = lspData.get(item);
  if (data !== undefined) result.data = data;
  if (item.kind !== undefined) result.kind = item.kind.value;
  if (item.diagnostics !== undefined) {
    result.diagnostics = item.diagnostics.map((d) => toLspDiagnostic(code, d));
  }
  if (item.command !== undefined) {
    result.command = {
      title: item.command.title,
      command: item.command.command,
      arguments: item.command.arguments,
    };
  }
  if (item.isPreferred !== undefined) result.isPreferred = item.isPreferred;
  if (item.disabled !== undefined) {
    result.disabled = { reason: item.disabled.reason };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

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
