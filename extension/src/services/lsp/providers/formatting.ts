/**
 * Document formatting and range formatting provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/formatting.ts
 *
 * Two separate registrations: document-level and range-level.
 * OnType formatting is not implemented (neither Ruff nor ty use it).
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import { toLspRange, toTextEdit } from "../converters.ts";

/**
 * Read file-level formatting options from workspace config.
 *
 * Reference: formatting.ts FileFormattingOptions.fromConfiguration
 */
function getFileFormattingOptions(code: VsCode, doc: vscode.TextDocument) {
  return Effect.map(code.workspace.getConfiguration("files", doc), (cfg) => ({
    trimTrailingWhitespace:
      cfg.get<boolean>("trimTrailingWhitespace") || undefined,
    trimFinalNewlines: cfg.get<boolean>("trimFinalNewlines") || undefined,
    insertFinalNewline: cfg.get<boolean>("insertFinalNewline") || undefined,
  }));
}

export const registerDocumentFormattingProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.documentFormattingProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDocumentFormattingEditProvider(sel, {
    provideDocumentFormattingEdits: Effect.fn(function* (doc, opts) {
      const fileOpts = yield* getFileFormattingOptions(code, doc);
      const result = yield* client.sendRequest(
        lsp.DocumentFormattingRequest.method,
        {
          textDocument: { uri: doc.uri.toString() },
          options: {
            tabSize: opts.tabSize,
            insertSpaces: opts.insertSpaces,
            ...fileOpts,
          },
        } satisfies lsp.DocumentFormattingParams,
      );
      return result?.map((e) => toTextEdit(code, e)) ?? [];
    }),
  });
});

export const registerDocumentRangeFormattingProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.documentRangeFormattingProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerDocumentRangeFormattingEditProvider(sel, {
    provideDocumentRangeFormattingEdits: Effect.fn(
      function* (doc, range, opts) {
        const fileOpts = yield* getFileFormattingOptions(code, doc);
        const result = yield* client.sendRequest(
          lsp.DocumentRangeFormattingRequest.method,
          {
            textDocument: { uri: doc.uri.toString() },
            range: toLspRange(range),
            options: {
              tabSize: opts.tabSize,
              insertSpaces: opts.insertSpaces,
              ...fileOpts,
            },
          } satisfies lsp.DocumentRangeFormattingParams,
        );
        return result?.map((e) => toTextEdit(code, e)) ?? [];
      },
    ),
  });
});
