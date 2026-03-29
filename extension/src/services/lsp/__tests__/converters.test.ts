import { describe, expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as lsp from "vscode-languageserver-protocol";

import { TestVsCode } from "../../../__mocks__/TestVsCode.ts";
import { VsCode } from "../../VsCode.ts";
import { toLocationResult, toVsCodeRange } from "../providers/converters.ts";
import { toDocumentHighlight } from "../providers/documentHighlight.ts";
import { toDocumentSymbol } from "../providers/documentSymbol.ts";
import { toFoldingRange } from "../providers/foldingRange.ts";
import { toHoverContent } from "../providers/hover.ts";
import { toSelectionRange } from "../providers/selectionRange.ts";

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
          "kind": "imports",
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
