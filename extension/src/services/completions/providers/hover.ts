/**
 * Hover provider registration.
 *
 * Reference: vscode-languageserver-node/client/src/common/hover.ts
 *
 * Simple request/response — no round-trip state.
 * Sends textDocument/hover, converts MarkupContent → MarkdownString.
 */

import { Effect } from "effect";
import type * as vscode from "vscode";
import * as lsp from "vscode-languageserver-protocol";

import type { NotebookLspClient } from "../../../utils/makeMarimoLspClient.ts";
import { VsCode } from "../../VsCode.ts";

// ---------------------------------------------------------------------------
// Converters
// ---------------------------------------------------------------------------

function toVsCodeRange(code: VsCode, range: lsp.Range): vscode.Range {
  return new code.Range(
    range.start.line,
    range.start.character,
    range.end.line,
    range.end.character,
  );
}

/**
 * Convert LSP hover contents to VS Code MarkdownString(s).
 *
 * Reference: protocolConverter.ts asHoverContent
 */
function toHoverContent(
  code: VsCode,
  contents: lsp.Hover["contents"],
): vscode.MarkdownString | vscode.MarkdownString[] {
  if (typeof contents === "string") {
    return new code.MarkdownString(contents);
  }
  if ("kind" in contents) {
    return new code.MarkdownString(contents.value);
  }
  if (Array.isArray(contents)) {
    return contents.map((item) => {
      const md = new code.MarkdownString();
      if (typeof item === "string") {
        md.appendMarkdown(item);
      } else {
        md.appendCodeblock(item.value, item.language);
      }
      return md;
    });
  }
  const md = new code.MarkdownString();
  md.appendCodeblock(contents.value, contents.language);
  return md;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export const registerHoverProvider = Effect.fn(function*(
  sel: vscode.DocumentSelector,
  client: NotebookLspClient,
) {

  if (!client.serverInfo.capabilities.hoverProvider) {
    return;
  }

  const code = yield* VsCode;

  yield* code.languages.registerHoverProvider(sel, {
    provideHover: Effect.fn(function*(doc, pos) {
      const result = yield* client.sendRequest(lsp.HoverRequest.method, {
        textDocument: { uri: doc.uri.toString() },
        position: { line: pos.line, character: pos.character },
      });

      if (!result) {
        return undefined;
      }

      return new code.Hover(
        toHoverContent(code, result.contents),
        result.range ? toVsCodeRange(code, result.range) : undefined,
      );
    })
  });
});
