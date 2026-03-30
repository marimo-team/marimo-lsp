/**
 * Hover provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/hover.ts
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import { VsCode } from "../../platform/VsCode.ts";
import type { NotebookLspClient } from "../client.ts";
import {
  toDocumentPositionParams,
  toHoverContent,
  toVsCodeRange,
} from "../converters.ts";

export const registerHoverProvider = Effect.fn(function* (
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {
  if (!client.serverInfo.capabilities.hoverProvider) return;
  const code = yield* VsCode;

  yield* code.languages.registerHoverProvider(sel, {
    provideHover: Effect.fn(function* (doc, pos) {
      const result = yield* client.sendRequest(
        lsp.HoverRequest.method,
        toDocumentPositionParams(doc, pos),
      );
      if (!result) return undefined;
      return new code.Hover(
        toHoverContent(code, result.contents),
        result.range ? toVsCodeRange(code, result.range) : undefined,
      );
    }),
  });
});
