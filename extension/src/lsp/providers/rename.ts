/**
 * Rename provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/rename.ts
 *
 * Supports optional `prepareProvider` for prepare rename.
 * The prepare response has 3 shapes: Range, {defaultBehavior},
 * or {range, placeholder}.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toVsCodeRange, toWorkspaceEdit } from "../converters.ts";

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerRenameProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  const caps = client.serverInfo.capabilities.renameProvider;
  if (!caps) return;
  const code = yield* VsCode;

  const prepareProvider = typeof caps === "object" && caps.prepareProvider;

  yield* code.languages.registerRenameProvider(sel, {
    provideRenameEdits: Effect.fn(function* (doc, pos, newName) {
      const result = yield* client.sendRequest(lsp.RenameRequest.method, {
        textDocument: { uri: doc.uri.toString() },
        position: { line: pos.line, character: pos.character },
        newName,
      });
      if (!result) return undefined;
      return toWorkspaceEdit(code, result);
    }),
    prepareRename: prepareProvider
      ? Effect.fn(function* (doc, pos) {
          const result = yield* client.sendRequest(
            lsp.PrepareRenameRequest.method,
            {
              textDocument: { uri: doc.uri.toString() },
              position: { line: pos.line, character: pos.character },
            },
          );
          if (!result) return undefined;
          // Shape 1: Range
          if (lsp.Range.is(result)) {
            return toVsCodeRange(code, result);
          }
          // Shape 2: { defaultBehavior: boolean }
          if ("defaultBehavior" in result) {
            return result.defaultBehavior ? undefined : undefined;
          }
          // Shape 3: { range, placeholder }
          if ("range" in result && "placeholder" in result) {
            return {
              range: toVsCodeRange(code, result.range),
              placeholder: result.placeholder,
            };
          }
          return undefined;
        })
      : undefined,
  });
});
