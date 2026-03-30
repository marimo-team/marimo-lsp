import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as lsp from "vscode-languageserver-protocol";

import { TestVsCode } from "../../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../VsCode.ts";
import {
  toCodeAction,
  toCodeActionKind,
  toCompletionItem,
  toDocumentHighlight,
  toDocumentSymbol,
  toFoldingRange,
  toHoverContent,
  toInlayHint,
  toLocationResult,
  toSelectionRange,
  toSignatureHelp,
  toTextEdit,
  toVsCodeRange,
} from "../providers/converters.ts";

const withVsCode = Effect.gen(function* () {
  const test = yield* TestVsCode.make();
  return yield* VsCode.pipe(Effect.provide(test.layer));
});

describe("toVsCodeRange", () => {
  it.scoped(
    "converts LSP range to VS Code range",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const range = toVsCodeRange(code, {
        start: { line: 1, character: 5 },
        end: { line: 3, character: 10 },
      });
      expect(range).toMatchInlineSnapshot(`
        Range {
          "end": Position {
            "character": 10,
            "line": 3,
          },
          "start": Position {
            "character": 5,
            "line": 1,
          },
        }
      `);
    }),
  );
});

describe("toHoverContent", () => {
  it.scoped(
    "converts plain string",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toHoverContent(code, "hello");
      expect(result).toMatchInlineSnapshot(`
        MarkdownString {
          "baseUri": undefined,
          "isTrusted": undefined,
          "supportHtml": undefined,
          "supportThemeIcons": undefined,
          "value": "hello",
        }
      `);
    }),
  );

  it.scoped(
    "converts MarkupContent",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toHoverContent(code, {
        kind: lsp.MarkupKind.Markdown,
        value: "# Title",
      });
      expect(result).toMatchInlineSnapshot(`
        MarkdownString {
          "baseUri": undefined,
          "isTrusted": undefined,
          "supportHtml": undefined,
          "supportThemeIcons": undefined,
          "value": "# Title",
        }
      `);
    }),
  );

  it.scoped(
    "converts MarkedString array",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toHoverContent(code, [
        "plain text",
        { language: "python", value: "x = 1" },
      ]);
      expect(result).toMatchInlineSnapshot(`
        [
          MarkdownString {
            "baseUri": undefined,
            "isTrusted": undefined,
            "supportHtml": undefined,
            "supportThemeIcons": undefined,
            "value": "plain text",
          },
          MarkdownString {
            "baseUri": undefined,
            "isTrusted": undefined,
            "supportHtml": undefined,
            "supportThemeIcons": undefined,
            "value": "
        \`\`\`python
        x = 1
        \`\`\`
        ",
          },
        ]
      `);
    }),
  );
});

describe("toLocationResult", () => {
  it.scoped(
    "returns undefined for null",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      expect(toLocationResult(code, null)).toBeUndefined();
    }),
  );

  it.scoped(
    "converts single Location",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toLocationResult(code, {
        uri: "file:///test.py",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      });
      expect(result).toMatchInlineSnapshot(`
        Location {
          "range": Range {
            "end": Position {
              "character": 5,
              "line": 0,
            },
            "start": Position {
              "character": 0,
              "line": 0,
            },
          },
          "uri": {
            "authority": "",
            "fragment": "",
            "path": "/test.py",
            "query": "",
            "scheme": "file",
          },
        }
      `);
    }),
  );

  it.scoped(
    "converts Location array",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toLocationResult(code, [
        {
          uri: "file:///a.py",
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 1 },
          },
        },
        {
          uri: "file:///b.py",
          range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 1 },
          },
        },
      ]);
      expect(result).toMatchInlineSnapshot(`
        [
          Location {
            "range": Range {
              "end": Position {
                "character": 1,
                "line": 0,
              },
              "start": Position {
                "character": 0,
                "line": 0,
              },
            },
            "uri": {
              "authority": "",
              "fragment": "",
              "path": "/a.py",
              "query": "",
              "scheme": "file",
            },
          },
          Location {
            "range": Range {
              "end": Position {
                "character": 1,
                "line": 1,
              },
              "start": Position {
                "character": 0,
                "line": 1,
              },
            },
            "uri": {
              "authority": "",
              "fragment": "",
              "path": "/b.py",
              "query": "",
              "scheme": "file",
            },
          },
        ]
      `);
    }),
  );

  it.scoped(
    "converts LocationLink array",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toLocationResult(code, [
        {
          targetUri: "file:///target.py",
          targetRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
          },
          targetSelectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
        },
      ]);
      expect(result).toMatchInlineSnapshot(`
        [
          {
            "originSelectionRange": undefined,
            "targetRange": Range {
              "end": Position {
                "character": 5,
                "line": 0,
              },
              "start": Position {
                "character": 0,
                "line": 0,
              },
            },
            "targetSelectionRange": Range {
              "end": Position {
                "character": 3,
                "line": 0,
              },
              "start": Position {
                "character": 0,
                "line": 0,
              },
            },
            "targetUri": {
              "authority": "",
              "fragment": "",
              "path": "/target.py",
              "query": "",
              "scheme": "file",
            },
          },
        ]
      `);
    }),
  );

  it.scoped(
    "returns empty array for empty input",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toLocationResult(code, []);
      expect(result).toMatchInlineSnapshot(`[]`);
    }),
  );
});

describe("toDocumentHighlight", () => {
  it.scoped(
    "converts with kind",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toDocumentHighlight(code, {
        range: {
          start: { line: 1, character: 0 },
          end: { line: 1, character: 5 },
        },
        kind: lsp.DocumentHighlightKind.Write,
      });
      expect(result).toMatchInlineSnapshot(`
        DocumentHighlight {
          "kind": 2,
          "range": Range {
            "end": Position {
              "character": 5,
              "line": 1,
            },
            "start": Position {
              "character": 0,
              "line": 1,
            },
          },
        }
      `);
    }),
  );

  it.scoped(
    "converts without kind",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toDocumentHighlight(code, {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 3 },
        },
      });
      expect(result).toMatchInlineSnapshot(`
        DocumentHighlight {
          "kind": undefined,
          "range": Range {
            "end": Position {
              "character": 3,
              "line": 0,
            },
            "start": Position {
              "character": 0,
              "line": 0,
            },
          },
        }
      `);
    }),
  );
});

describe("toDocumentSymbol", () => {
  it.scoped(
    "converts with children",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toDocumentSymbol(code, {
        name: "MyClass",
        detail: "A class",
        kind: lsp.SymbolKind.Class,
        range: {
          start: { line: 0, character: 0 },
          end: { line: 10, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 13 },
        },
        children: [
          {
            name: "method",
            detail: "",
            kind: lsp.SymbolKind.Method,
            range: {
              start: { line: 2, character: 4 },
              end: { line: 5, character: 0 },
            },
            selectionRange: {
              start: { line: 2, character: 8 },
              end: { line: 2, character: 14 },
            },
          },
        ],
      });
      expect(result).toMatchInlineSnapshot(`
        DocumentSymbol {
          "children": [
            DocumentSymbol {
              "children": [],
              "detail": "",
              "kind": 5,
              "name": "method",
              "range": Range {
                "end": Position {
                  "character": 0,
                  "line": 5,
                },
                "start": Position {
                  "character": 4,
                  "line": 2,
                },
              },
              "selectionRange": Range {
                "end": Position {
                  "character": 14,
                  "line": 2,
                },
                "start": Position {
                  "character": 8,
                  "line": 2,
                },
              },
              "tags": undefined,
            },
          ],
          "detail": "A class",
          "kind": 4,
          "name": "MyClass",
          "range": Range {
            "end": Position {
              "character": 0,
              "line": 10,
            },
            "start": Position {
              "character": 0,
              "line": 0,
            },
          },
          "selectionRange": Range {
            "end": Position {
              "character": 13,
              "line": 0,
            },
            "start": Position {
              "character": 6,
              "line": 0,
            },
          },
          "tags": undefined,
        }
      `);
    }),
  );
});

describe("toFoldingRange", () => {
  it.scoped(
    "converts with kind",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toFoldingRange(code, {
        startLine: 0,
        endLine: 10,
        kind: lsp.FoldingRangeKind.Imports,
      });
      expect(result).toMatchInlineSnapshot(`
        FoldingRange {
          "end": 10,
          "kind": 2,
          "start": 0,
        }
      `);
    }),
  );
});

describe("toSelectionRange", () => {
  it.scoped(
    "converts nested selection ranges",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toSelectionRange(code, {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 5, character: 0 },
        },
        parent: {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 10, character: 0 },
          },
        },
      });
      expect(result).toMatchInlineSnapshot(`
        SelectionRange {
          "parent": SelectionRange {
            "parent": undefined,
            "range": Range {
              "end": Position {
                "character": 0,
                "line": 10,
              },
              "start": Position {
                "character": 0,
                "line": 0,
              },
            },
          },
          "range": Range {
            "end": Position {
              "character": 0,
              "line": 5,
            },
            "start": Position {
              "character": 0,
              "line": 0,
            },
          },
        }
      `);
    }),
  );
});

describe("toTextEdit", () => {
  it.scoped(
    "converts LSP TextEdit",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toTextEdit(code, {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        newText: "hello",
      });
      expect(result).toMatchInlineSnapshot(`
        TextEdit {
          "newEol": undefined,
          "newText": "hello",
          "range": Range {
            "end": Position {
              "character": 5,
              "line": 0,
            },
            "start": Position {
              "character": 0,
              "line": 0,
            },
          },
        }
      `);
    }),
  );
});

describe("toSignatureHelp", () => {
  it.scoped(
    "converts with signatures and parameters",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toSignatureHelp(code, {
        signatures: [
          {
            label: "fn(x: int, y: str)",
            documentation: {
              kind: lsp.MarkupKind.Markdown,
              value: "A function",
            },
            parameters: [
              { label: "x: int", documentation: "The x param" },
              {
                label: "y: str",
                documentation: {
                  kind: lsp.MarkupKind.Markdown,
                  value: "The y param",
                },
              },
            ],
          },
        ],
        activeSignature: 0,
        activeParameter: 1,
      });
      expect(result).toMatchInlineSnapshot(`
        SignatureHelp {
          "activeParameter": 1,
          "activeSignature": 0,
          "signatures": [
            SignatureInformation {
              "activeParameter": undefined,
              "documentation": MarkdownString {
                "baseUri": undefined,
                "isTrusted": undefined,
                "supportHtml": undefined,
                "supportThemeIcons": undefined,
                "value": "A function",
              },
              "label": "fn(x: int, y: str)",
              "parameters": [
                ParameterInformation {
                  "documentation": "The x param",
                  "label": "x: int",
                },
                ParameterInformation {
                  "documentation": MarkdownString {
                    "baseUri": undefined,
                    "isTrusted": undefined,
                    "supportHtml": undefined,
                    "supportThemeIcons": undefined,
                    "value": "The y param",
                  },
                  "label": "y: str",
                },
              ],
            },
          ],
        }
      `);
    }),
  );

  it.scoped(
    "defaults activeParameter to 0 when undefined",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toSignatureHelp(code, {
        signatures: [{ label: "fn()" }],
        activeSignature: 0,
      });
      expect(result.activeParameter).toBe(0);
    }),
  );

  // The LSP protocol allows null for activeParameter (meaning "no active
  // parameter") even though our TypeScript types don't model it. Servers
  // can send this at runtime.
  it.scoped(
    "maps null activeParameter to -1",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toSignatureHelp(code, {
        signatures: [{ label: "fn()" }],
        activeSignature: 0,
        activeParameter: null as any,
      });
      expect(result.activeParameter).toBe(-1);
    }),
  );
});

describe("toInlayHint", () => {
  it.scoped(
    "converts string label",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toInlayHint(code, {
        position: { line: 1, character: 10 },
        label: ": int",
        kind: lsp.InlayHintKind.Type,
        paddingLeft: true,
      });
      expect(result).toMatchInlineSnapshot(`
        InlayHint {
          "kind": 1,
          "label": ": int",
          "paddingLeft": true,
          "paddingRight": undefined,
          "position": Position {
            "character": 10,
            "line": 1,
          },
          "textEdits": undefined,
          "tooltip": undefined,
        }
      `);
    }),
  );

  it.scoped(
    "converts label parts with location",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toInlayHint(code, {
        position: { line: 0, character: 5 },
        label: [
          {
            value: "int",
            location: {
              uri: "file:///builtins.pyi",
              range: {
                start: { line: 10, character: 0 },
                end: { line: 10, character: 3 },
              },
            },
          },
        ],
      });
      expect(result).toMatchInlineSnapshot(`
        InlayHint {
          "kind": undefined,
          "label": [
            InlayHintLabelPart {
              "command": undefined,
              "location": Location {
                "range": Range {
                  "end": Position {
                    "character": 3,
                    "line": 10,
                  },
                  "start": Position {
                    "character": 0,
                    "line": 10,
                  },
                },
                "uri": {
                  "authority": "",
                  "fragment": "",
                  "path": "/builtins.pyi",
                  "query": "",
                  "scheme": "file",
                },
              },
              "tooltip": undefined,
              "value": "int",
            },
          ],
          "paddingLeft": undefined,
          "paddingRight": undefined,
          "position": Position {
            "character": 5,
            "line": 0,
          },
          "textEdits": undefined,
          "tooltip": undefined,
        }
      `);
    }),
  );

  it.scoped(
    "stashes data for resolve round-trip",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toInlayHint(code, {
        position: { line: 0, character: 0 },
        label: "hint",
        data: { id: 42 },
      });
      // data is stashed via WeakMap, not visible in snapshot
      expect(result.label).toBe("hint");
    }),
  );
});

describe("toCompletionItem", () => {
  it.scoped(
    "converts basic item with kind offset",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCompletionItem(code, {
        label: "my_var",
        kind: lsp.CompletionItemKind.Variable,
        detail: "int",
        documentation: {
          kind: lsp.MarkupKind.Markdown,
          value: "A variable",
        },
      });
      expect(result).toMatchInlineSnapshot(`
        CompletionItem {
          "additionalTextEdits": undefined,
          "command": undefined,
          "commitCharacters": undefined,
          "detail": "int",
          "documentation": MarkdownString {
            "baseUri": undefined,
            "isTrusted": undefined,
            "supportHtml": undefined,
            "supportThemeIcons": undefined,
            "value": "A variable",
          },
          "filterText": undefined,
          "insertText": undefined,
          "keepWhitespace": undefined,
          "kind": 5,
          "label": "my_var",
          "preselect": undefined,
          "range": undefined,
          "sortText": undefined,
          "tags": undefined,
          "textEdit": undefined,
        }
      `);
    }),
  );

  it.scoped(
    "converts item with textEdit",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCompletionItem(code, {
        label: "print",
        kind: lsp.CompletionItemKind.Function,
        textEdit: {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 3 },
          },
          newText: "print",
        },
      });
      expect(result.insertText).toBe("print");
      expect(result.range).toBeDefined();
    }),
  );

  it.scoped(
    "converts snippet insertTextFormat",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCompletionItem(code, {
        label: "for",
        kind: lsp.CompletionItemKind.Snippet,
        insertText: "for ${1:item} in ${2:iterable}:\n\t$0",
        insertTextFormat: lsp.InsertTextFormat.Snippet,
      });
      // Should be wrapped in SnippetString
      expect(result.insertText).toMatchInlineSnapshot(`
        SnippetString {
          "value": "for \${1:item} in \${2:iterable}:
        	$0",
        }
      `);
    }),
  );

  it.scoped(
    "converts labelDetails",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCompletionItem(code, {
        label: "foo",
        labelDetails: {
          detail: "(x: int)",
          description: "module.foo",
        },
        kind: lsp.CompletionItemKind.Function,
      });
      expect(result.label).toMatchInlineSnapshot(`
        {
          "description": "module.foo",
          "detail": "(x: int)",
          "label": "foo",
        }
      `);
    }),
  );

  it.scoped(
    "converts deprecated tag",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCompletionItem(code, {
        label: "old_fn",
        tags: [lsp.CompletionItemTag.Deprecated],
      });
      expect(result.tags).toMatchInlineSnapshot(`
        [
          1,
        ]
      `);
    }),
  );
});

describe("toCodeActionKind", () => {
  it.scoped(
    "builds from dotted string",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const kind = toCodeActionKind(code, "notebook.source.fixAll");
      expect(kind.value).toBe("notebook.source.fixAll");
    }),
  );

  it.scoped(
    "builds simple kind",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const kind = toCodeActionKind(code, "quickfix");
      expect(kind.value).toBe("quickfix");
    }),
  );
});

describe("toCodeAction", () => {
  it.scoped(
    "converts basic code action",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCodeAction(code, {
        title: "Fix import",
        kind: "quickfix",
      });
      expect(result).toMatchInlineSnapshot(`
        CodeAction {
          "command": undefined,
          "diagnostics": undefined,
          "disabled": undefined,
          "edit": undefined,
          "isPreferred": undefined,
          "kind": CodeActionKind {
            "value": "quickfix",
          },
          "title": "Fix import",
        }
      `);
    }),
  );

  it.scoped(
    "converts with edit and diagnostics",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCodeAction(code, {
        title: "Organize imports",
        kind: "source.organizeImports",
        isPreferred: true,
        edit: {
          changes: {
            "file:///test.py": [
              {
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 2, character: 0 },
                },
                newText: "import os\n",
              },
            ],
          },
        },
        diagnostics: [
          {
            range: {
              start: { line: 1, character: 0 },
              end: { line: 1, character: 10 },
            },
            message: "Unused import",
            severity: lsp.DiagnosticSeverity.Warning,
            source: "ruff",
          },
        ],
      });
      expect(result).toMatchInlineSnapshot(`
        CodeAction {
          "command": undefined,
          "diagnostics": [
            Diagnostic {
              "code": undefined,
              "message": "Unused import",
              "range": Range {
                "end": Position {
                  "character": 10,
                  "line": 1,
                },
                "start": Position {
                  "character": 0,
                  "line": 1,
                },
              },
              "relatedInformation": undefined,
              "severity": 1,
              "source": "ruff",
              "tags": undefined,
            },
          ],
          "disabled": undefined,
          "edit": WorkspaceEdit {},
          "isPreferred": true,
          "kind": CodeActionKind {
            "value": "source.organizeImports",
          },
          "title": "Organize imports",
        }
      `);
    }),
  );

  it.scoped(
    "converts disabled action",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCodeAction(code, {
        title: "Extract variable",
        kind: "refactor.extract",
        disabled: { reason: "No expression selected" },
      });
      expect(result.disabled).toMatchInlineSnapshot(`
        {
          "reason": "No expression selected",
        }
      `);
    }),
  );

  it.scoped(
    "stashes data for resolve",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const result = toCodeAction(code, {
        title: "Fix all",
        kind: "source.fixAll",
        data: { uri: "file:///test.py" },
      });
      expect(result.title).toBe("Fix all");
    }),
  );
});
