/**
 * Integration tests for `makeNotebookLspClient` against a real `ty` LSP
 * server spawned via `uv run ty server`. Unlike mocked tests, these exercise
 * the real JSON-RPC stack: stdio framing, initialize handshake, capability
 * negotiation, notebook sync, and shutdown.
 *
 * Requires `uv` and `ty` on PATH. Assertions are intentionally loose where
 * server output (versions, exact capability shapes, hover content) may drift
 * between upstream ty releases.
 */

import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as lsp from "vscode-languageserver-protocol";

import {
  createTestNotebookDocument,
  TestVsCode,
} from "../../__mocks__/TestVsCode.ts";
import { VariablesService } from "../../panel/variables/VariablesService.ts";
import { VsCode } from "../../platform/VsCode.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import { makeNotebookLspClient } from "../client.ts";

describe("makeNotebookLspClient against uv run ty server", () => {
  it.scoped(
    "initialize → openNotebook → hover → textChange → close",
    () =>
      Effect.gen(function* () {
        const test = yield* TestVsCode.make();
        const code = yield* VsCode.pipe(Effect.provide(test.layer));
        const outputChannel = yield* code.window.createOutputChannel("ty");

        const client = yield* makeNotebookLspClient({
          name: "ty",
          command: "uv",
          args: ["run", "ty", "server"],
          outputChannel,
          workspaceFolders: [],
        });

        // --- 1. Server handshake -------------------------------------------
        expect(client.serverInfo.name).toBe("ty");
        expect(typeof client.serverInfo.version).toBe("string");
        expect(Object.keys(client.serverInfo.capabilities).sort())
          .toMatchInlineSnapshot(`
      	[
      	  "codeActionProvider",
      	  "completionProvider",
      	  "declarationProvider",
      	  "definitionProvider",
      	  "diagnosticProvider",
      	  "documentHighlightProvider",
      	  "documentSymbolProvider",
      	  "executeCommandProvider",
      	  "foldingRangeProvider",
      	  "hoverProvider",
      	  "inlayHintProvider",
      	  "notebookDocumentSync",
      	  "positionEncoding",
      	  "referencesProvider",
      	  "renameProvider",
      	  "selectionRangeProvider",
      	  "semanticTokensProvider",
      	  "signatureHelpProvider",
      	  "textDocumentSync",
      	  "typeDefinitionProvider",
      	  "typeHierarchyProvider",
      	  "workspace",
      	  "workspaceSymbolProvider",
      	]
      `);

        // --- 2. Build a notebook with one Python cell ---------------------
        // `x` is declared at the start of the line so hover at (0,0) lands
        // on a symbol ty can describe.
        const notebook = createTestNotebookDocument("/nb.py", {
          data: {
            cells: [
              {
                kind: 2, // NotebookCellKind.Code
                value: "x: int = 1\n",
                languageId: "python",
              },
            ],
          },
        });
        const doc = MarimoNotebookDocument.from(notebook);
        const cell = notebook.cellAt(0);

        // --- 3. Open the notebook (fires didOpen) --------------------------
        yield* client.openNotebookDocument(doc);

        // --- 4. Send a typed request (hover on `x`) ------------------------
        // ty declares `diagnosticProvider` (pull-based) so push-diagnostics
        // aren't exercised here; a hover round-trip is the accuracy signal.
        const hover = yield* client.sendRequest(lsp.HoverRequest.method, {
          textDocument: { uri: cell.document.uri.toString() },
          position: { line: 0, character: 0 },
        });
        expect(hover).toMatchInlineSnapshot(`
      	{
      	  "contents": {
      	    "kind": "markdown",
      	    "value": "\`\`\`python
      	Literal[1]
      	\`\`\`",
      	  },
      	  "range": {
      	    "end": {
      	      "character": 1,
      	      "line": 0,
      	    },
      	    "start": {
      	      "character": 0,
      	      "line": 0,
      	    },
      	  },
      	}
      `);

        // --- 5. Forward a text edit within the cell ------------------------
        yield* client.textDocumentChange({
          document: cell.document,
          contentChanges: [
            {
              range: new code.Range(0, 0, 0, 0),
              rangeOffset: 0,
              rangeLength: 0,
              text: "# leading comment\n",
            },
          ],
          reason: undefined,
        });

        // --- 6. Close the notebook (fires didClose) ------------------------
        yield* client.closeNotebookDocument(doc);

        // Scope closes → shutdown request + exit notification + process kill
        // are asserted implicitly by the test completing without hanging.
      }).pipe(Effect.provide(VariablesService.Default)),
    { timeout: 30_000 },
  );
});
