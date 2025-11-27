import { assert, describe, expect, it } from "vitest";
import { extractTokensForCell } from "../semanticTokens.ts";

describe("extractTokensForCell", () => {
  it("returns null for empty input", () => {
    expect(
      extractTokensForCell(new Uint32Array([]), {
        cellStartLine: 0,
        cellLineCount: 5,
      }),
    ).toBeNull();
  });

  it("returns null when no tokens in cell range", () => {
    const tokens = buildTokens([
      { line: 0, char: 0, length: 3, type: 1 },
      { line: 0, char: 4, length: 3, type: 2 },
    ]);

    expect(
      extractTokensForCell(tokens, { cellStartLine: 5, cellLineCount: 3 }),
    ).toBeNull();
  });

  it("extracts tokens and remaps line numbers", () => {
    // Tokens across 3 lines, extract middle 2
    const tokens = buildTokens([
      { line: 0, char: 0, length: 9, type: 1 },
      { line: 1, char: 0, length: 3, type: 2 },
      { line: 1, char: 4, length: 3, type: 3 },
      { line: 2, char: 4, length: 6, type: 4 },
    ]);

    const result = extractTokensForCell(tokens, {
      cellStartLine: 1,
      cellLineCount: 2,
    });
    assert(result, "Expected tokens but got null");
    expect(decodeTokens(result)).toMatchInlineSnapshot(`
      [
        {
          "char": 0,
          "length": 3,
          "line": 0,
          "type": 2,
        },
        {
          "char": 4,
          "length": 3,
          "line": 0,
          "type": 3,
        },
        {
          "char": 4,
          "length": 6,
          "line": 1,
          "type": 4,
        },
      ]
    `);
  });

  it("handles multiple tokens on same line", () => {
    const tokens = buildTokens([
      { line: 0, char: 0, length: 1, type: 1 },
      { line: 0, char: 4, length: 1, type: 2 },
      { line: 0, char: 8, length: 1, type: 3 },
    ]);

    const result = extractTokensForCell(tokens, {
      cellStartLine: 0,
      cellLineCount: 1,
    });
    assert(result, "Expected tokens but got null");
    expect(decodeTokens(result)).toMatchInlineSnapshot(`
      [
        {
          "char": 0,
          "length": 1,
          "line": 0,
          "type": 1,
        },
        {
          "char": 4,
          "length": 1,
          "line": 0,
          "type": 2,
        },
        {
          "char": 8,
          "length": 1,
          "line": 0,
          "type": 3,
        },
      ]
    `);
  });

  it("filters to only tokens within cell range", () => {
    const tokens = buildTokens([
      { line: 0, char: 0, length: 5, type: 1 },
      { line: 1, char: 0, length: 5, type: 2 },
      { line: 2, char: 0, length: 5, type: 3 },
      { line: 3, char: 0, length: 5, type: 4 },
    ]);

    const result = extractTokensForCell(tokens, {
      cellStartLine: 1,
      cellLineCount: 2,
    });
    assert(result, "Expected tokens but got null");
    expect(decodeTokens(result)).toMatchInlineSnapshot(`
      [
        {
          "char": 0,
          "length": 5,
          "line": 0,
          "type": 2,
        },
        {
          "char": 0,
          "length": 5,
          "line": 1,
          "type": 3,
        },
      ]
    `);
  });

  it("handles cell at end of document", () => {
    const tokens = buildTokens([
      { line: 0, char: 0, length: 5, type: 1 },
      { line: 1, char: 0, length: 6, type: 2 },
      { line: 2, char: 0, length: 5, type: 3 },
    ]);

    const result = extractTokensForCell(tokens, {
      cellStartLine: 2,
      cellLineCount: 1,
    });
    assert(result, "Expected tokens but got null");
    expect(decodeTokens(result)).toMatchInlineSnapshot(`
      [
        {
          "char": 0,
          "length": 5,
          "line": 0,
          "type": 3,
        },
      ]
    `);
  });
});

/**
 * Build encoded semantic tokens from structured input.
 */
function buildTokens(
  tokens: Array<{ line: number; char: number; length: number; type: number }>,
): Uint32Array {
  const sorted = [...tokens].sort((a, b) => a.line - b.line || a.char - b.char);

  const encoded: number[] = [];
  let prevLine = 0;
  let prevChar = 0;

  for (const { line, char, length, type } of sorted) {
    const deltaLine = line - prevLine;
    const deltaChar = deltaLine === 0 ? char - prevChar : char;
    encoded.push(deltaLine, deltaChar, length, type, 0);
    prevLine = line;
    prevChar = char;
  }

  return new Uint32Array(encoded);
}

/**
 * Decode semantic tokens to array of objects for easy assertion.
 */
function decodeTokens(
  data: Uint32Array,
): Array<{ line: number; char: number; length: number; type: number }> {
  const tokens: Array<{
    line: number;
    char: number;
    length: number;
    type: number;
  }> = [];

  let line = 0;
  let char = 0;

  for (let i = 0; i < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaChar = data[i + 1];

    line += deltaLine;
    char = deltaLine === 0 ? char + deltaChar : deltaChar;

    tokens.push({ line, char, length: data[i + 2], type: data[i + 3] });
  }

  return tokens;
}
