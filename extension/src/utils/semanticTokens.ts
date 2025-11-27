/**
 * Utilities for working with LSP semantic tokens.
 *
 * LSP semantic tokens are encoded as a flat array of integers in groups of 5:
 * [deltaLine, deltaStartChar, length, tokenType, tokenModifiers]
 *
 * The encoding uses deltas to reduce payload size:
 * - deltaLine: lines since the previous token (0 means same line)
 * - deltaStartChar: if deltaLine === 0, this is relative to the previous token's start
 *                   otherwise, it's an absolute column position
 * - length: token length in characters
 * - tokenType: index into the legend's tokenTypes array
 * - tokenModifiers: bitmask of modifiers from the legend's tokenModifiers array
 */

/**
 * Extract semantic tokens for a cell from the virtual document's tokens.
 *
 * Filters tokens to only those within the specified line range and re-encodes
 * them with line numbers relative to the cell start.
 *
 * @param data - The encoded semantic tokens from the full virtual document
 * @param options - Options for extracting tokens
 * @param options.cellStartLine - The line in the virtual document where this cell starts
 * @param options.cellLineCount - Number of lines in this cell
 * @returns Encoded tokens for just this cell, or null if no tokens in range
 */
export function extractTokensForCell(
  data: Uint32Array | Array<number>,
  options: {
    cellStartLine: number;
    cellLineCount: number;
  },
): Uint32Array | null {
  const { cellStartLine, cellLineCount } = options;
  const cellEndLine = cellStartLine + cellLineCount;

  // Preallocate max possible size (same as input)
  const result = new Uint32Array(data.length);
  let writeOffset = 0;

  // Track absolute position as we decode
  let absoluteLine = 0;
  let absoluteChar = 0;

  // Track previous token position for re-encoding (relative to cell)
  let prevCellLine = 0;
  let prevCellChar = 0;
  let isFirstToken = true;

  for (let i = 0; i < data.length; i += 5) {
    const deltaLine = data[i];
    const deltaStartChar = data[i + 1];

    // Decode to absolute position
    absoluteLine += deltaLine;
    if (deltaLine === 0) {
      absoluteChar += deltaStartChar;
    } else {
      absoluteChar = deltaStartChar;
    }

    // Check if token is within cell range
    if (absoluteLine >= cellStartLine && absoluteLine < cellEndLine) {
      // Map to cell-relative line
      const cellLine = absoluteLine - cellStartLine;

      // Re-encode with deltas relative to previous cell token
      let encodedDeltaLine: number;
      let encodedDeltaChar: number;

      if (isFirstToken) {
        encodedDeltaLine = cellLine;
        encodedDeltaChar = absoluteChar;
        isFirstToken = false;
      } else {
        encodedDeltaLine = cellLine - prevCellLine;
        encodedDeltaChar =
          encodedDeltaLine === 0 ? absoluteChar - prevCellChar : absoluteChar;
      }

      result[writeOffset] = encodedDeltaLine;
      result[writeOffset + 1] = encodedDeltaChar;
      result[writeOffset + 2] = data[i + 2]; // length
      result[writeOffset + 3] = data[i + 3]; // tokenType
      result[writeOffset + 4] = data[i + 4]; // tokenModifiers
      writeOffset += 5;

      prevCellLine = cellLine;
      prevCellChar = absoluteChar;
    }
  }

  if (writeOffset === 0) {
    return null;
  }

  // Return a trimmed view if we didn't use the full buffer
  return writeOffset === data.length ? result : result.subarray(0, writeOffset);
}
