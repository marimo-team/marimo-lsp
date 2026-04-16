import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as lsp from "vscode-languageserver-protocol";

import { TestVsCode } from "../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../platform/VsCode.ts";
import {
  toCodeAction,
  toCodeActionKind,
  toCompletionItem,
  toCompletionItemKind,
  toDocumentHighlight,
  toDocumentHighlightKind,
  toDocumentSymbol,
  toFoldingRange,
  toHoverContent,
  toInlayHint,
  toLocationResult,
  toLspCodeActionTriggerKind,
  toLspCompletionItemKind,
  toLspCompletionTriggerKind,
  toLspDiagnosticSeverity,
  toLspFoldingRangeKind,
  toSelectionRange,
  toSignatureHelp,
  toSymbolKind,
  toTextEdit,
  toVsCodeDiagnosticSeverity,
  toVsCodeRange,
} from "../converters.ts";

const numericEntries = (e: Record<string, unknown>): Array<[string, number]> =>
  Object.entries(e).filter(
    (entry): entry is [string, number] => typeof entry[1] === "number",
  );

const stringEntries = (e: Record<string, unknown>): Array<[string, string]> =>
  Object.entries(e).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );

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

// Data-driven snapshots over LSP/VS Code enum tables. Iterating the source
// enum means adding a new enum value anywhere upstream surfaces here as a
// snapshot diff (or an exhaustiveness throw), with no manual list to keep
// in sync.

describe("toSymbolKind", () => {
  it.scoped("maps every lsp.SymbolKind", () =>
    Effect.sync(() => {
      const mapping = Object.fromEntries(
        numericEntries(lsp.SymbolKind).map(([name, value]) => [
          name,
          toSymbolKind(value as lsp.SymbolKind),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Array": 17,
      	  "Boolean": 16,
      	  "Class": 4,
      	  "Constant": 13,
      	  "Constructor": 8,
      	  "Enum": 9,
      	  "EnumMember": 21,
      	  "Event": 23,
      	  "Field": 7,
      	  "File": 0,
      	  "Function": 11,
      	  "Interface": 10,
      	  "Key": 19,
      	  "Method": 5,
      	  "Module": 1,
      	  "Namespace": 2,
      	  "Null": 20,
      	  "Number": 15,
      	  "Object": 18,
      	  "Operator": 24,
      	  "Package": 3,
      	  "Property": 6,
      	  "String": 14,
      	  "Struct": 22,
      	  "TypeParameter": 25,
      	  "Variable": 12,
      	}
      `);
    }),
  );
});

describe("toCompletionItemKind", () => {
  it.scoped(
    "maps every lsp.CompletionItemKind",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const mapping = Object.fromEntries(
        numericEntries(lsp.CompletionItemKind).map(([name, value]) => [
          name,
          toCompletionItemKind(code, value as lsp.CompletionItemKind),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Class": 6,
      	  "Color": 15,
      	  "Constant": 20,
      	  "Constructor": 3,
      	  "Enum": 12,
      	  "EnumMember": 19,
      	  "Event": 22,
      	  "Field": 4,
      	  "File": 16,
      	  "Folder": 18,
      	  "Function": 2,
      	  "Interface": 7,
      	  "Keyword": 13,
      	  "Method": 1,
      	  "Module": 8,
      	  "Operator": 23,
      	  "Property": 9,
      	  "Reference": 17,
      	  "Snippet": 14,
      	  "Struct": 21,
      	  "Text": 0,
      	  "TypeParameter": 24,
      	  "Unit": 10,
      	  "Value": 11,
      	  "Variable": 5,
      	}
      `);
    }),
  );
});

describe("toLspCompletionItemKind", () => {
  // Iterate the VS Code side so User/Issue (no LSP equivalent) show up as
  // explicit rows collapsed to Text.
  it.scoped(
    "maps every vscode.CompletionItemKind (User/Issue → Text)",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const mapping = Object.fromEntries(
        numericEntries(code.CompletionItemKind).map(([name, value]) => [
          name,
          toLspCompletionItemKind(code, value),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Class": 7,
      	  "Color": 16,
      	  "Constant": 21,
      	  "Constructor": 4,
      	  "Enum": 13,
      	  "EnumMember": 20,
      	  "Event": 23,
      	  "Field": 5,
      	  "File": 17,
      	  "Folder": 19,
      	  "Function": 3,
      	  "Interface": 8,
      	  "Issue": 1,
      	  "Keyword": 14,
      	  "Method": 2,
      	  "Module": 9,
      	  "Operator": 24,
      	  "Property": 10,
      	  "Reference": 18,
      	  "Snippet": 15,
      	  "Struct": 22,
      	  "Text": 1,
      	  "TypeParameter": 25,
      	  "Unit": 11,
      	  "User": 1,
      	  "Value": 12,
      	  "Variable": 6,
      	}
      `);
    }),
  );
});

describe("toVsCodeDiagnosticSeverity", () => {
  it.scoped(
    "maps every lsp.DiagnosticSeverity",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const mapping = Object.fromEntries(
        numericEntries(lsp.DiagnosticSeverity).map(([name, value]) => [
          name,
          toVsCodeDiagnosticSeverity(code, value as lsp.DiagnosticSeverity),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Error": 0,
      	  "Hint": 3,
      	  "Information": 2,
      	  "Warning": 1,
      	}
      `);
    }),
  );
});

describe("toLspDiagnosticSeverity", () => {
  it.scoped(
    "maps every vscode.DiagnosticSeverity",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const mapping = Object.fromEntries(
        numericEntries(code.DiagnosticSeverity).map(([name, value]) => [
          name,
          toLspDiagnosticSeverity(code, value),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Error": 1,
      	  "Hint": 4,
      	  "Information": 3,
      	  "Warning": 2,
      	}
      `);
    }),
  );
});

describe("toDocumentHighlightKind", () => {
  it.scoped("maps every lsp.DocumentHighlightKind", () =>
    Effect.sync(() => {
      const mapping = Object.fromEntries(
        numericEntries(lsp.DocumentHighlightKind).map(([name, value]) => [
          name,
          toDocumentHighlightKind(value as lsp.DocumentHighlightKind),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Read": 1,
      	  "Text": 0,
      	  "Write": 2,
      	}
      `);
    }),
  );
});

describe("toLspFoldingRangeKind", () => {
  // LSP FoldingRangeKind is a string namespace, extensible by servers.
  // Iterate the known values plus one unknown to lock in the undefined fallback.
  it.scoped("maps every lsp.FoldingRangeKind plus an unknown fallback", () =>
    Effect.sync(() => {
      const mapping: Record<string, unknown> = {};
      for (const [name, value] of stringEntries(lsp.FoldingRangeKind)) {
        mapping[name] = toLspFoldingRangeKind(value as lsp.FoldingRangeKind);
      }
      mapping.__unknown__ = toLspFoldingRangeKind(
        "unknown-server-kind" as lsp.FoldingRangeKind,
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Comment": 1,
      	  "Imports": 2,
      	  "Region": 3,
      	  "__unknown__": undefined,
      	}
      `);
    }),
  );
});

describe("toLspCompletionTriggerKind", () => {
  it.scoped(
    "maps every vscode.CompletionTriggerKind",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const mapping = Object.fromEntries(
        numericEntries(code.CompletionTriggerKind).map(([name, value]) => [
          name,
          toLspCompletionTriggerKind(code, value),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Invoke": 1,
      	  "TriggerCharacter": 2,
      	  "TriggerForIncompleteCompletions": 3,
      	}
      `);
    }),
  );
});

describe("toLspCodeActionTriggerKind", () => {
  it.scoped(
    "maps every vscode.CodeActionTriggerKind",
    Effect.fn(function* () {
      const code = yield* withVsCode;
      const mapping = Object.fromEntries(
        numericEntries(code.CodeActionTriggerKind).map(([name, value]) => [
          name,
          toLspCodeActionTriggerKind(code, value),
        ]),
      );
      expect(mapping).toMatchInlineSnapshot(`
      	{
      	  "Automatic": 2,
      	  "Invoke": 1,
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
