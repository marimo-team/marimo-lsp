/**
 * Classify a cell's Python source into a VS Code cell shape (smart-cells).
 *
 * A marimo markdown or SQL cell is just a Python cell whose code is a single
 * `mo.md(...)` / `mo.sql(...)` call. The `@marimo-team/smart-cells` parsers
 * detect that shape and `transformIn` strips the wrapper, yielding the raw
 * markdown/SQL the user actually edits plus the metadata needed to wrap it back
 * (`transformOut`) on save/execute.
 *
 * This is the single source of truth for that classification so the two paths
 * that ingest kernel-owned Python agree: {@link NotebookSerializer} (file open)
 * and {@link computeDesiredCells} (live document transactions). It is free of
 * `vscode` — the parsers are pure TS — so it stays trivially unit-testable.
 */

import { MarkdownParser, SQLParser } from "@marimo-team/smart-cells";

import type { CellMetadata } from "../schemas/CellMetadata.ts";

/** Matches `vscode.NotebookCellKind`: 1 = Markup, 2 = Code. Kept as literals so this module stays vscode-free. */
const MARKUP_KIND = 1;
const CODE_KIND = 2;

// Parsers are stateless; share one instance each.
const markdownParser = new MarkdownParser();
const sqlParser = new SQLParser();

/**
 * Resolved cell language ids. The Python id is config-dependent
 * (`"mo-python"` vs `"python"` per `disableManagedLanguageFeatures`), so it must
 * come from the `Constants` service rather than the static constant — the cell's
 * `document.languageId` is the resolved value and equivalence compares against it.
 */
export interface LanguageIds {
  readonly Python: string;
  readonly Sql: string;
  readonly Markdown: string;
}

export interface ClassifiedCell {
  /** `vscode.NotebookCellKind`: 1 = Markup, 2 = Code. */
  readonly kind: 1 | 2;
  readonly languageId: string;
  /** Display code: raw markdown/SQL for smart cells, the original Python otherwise. */
  readonly code: string;
  /** Smart-cell metadata needed to wrap the display code back to Python; undefined for plain Python. */
  readonly languageMetadata: CellMetadata["languageMetadata"];
}

/**
 * Classify kernel-owned Python source. Markdown wins over SQL (matching the
 * serializer's order); f-string `mo.md` stays Python because we can't round-trip
 * interpolation through a Markup cell.
 */
export function classifyCellCode(
  code: string,
  languageIds: LanguageIds,
): ClassifiedCell {
  if (code.trim()) {
    if (markdownParser.isSupported(code)) {
      const result = markdownParser.transformIn(code);
      if (!result.metadata.quotePrefix.includes("f")) {
        return {
          kind: MARKUP_KIND,
          languageId: languageIds.Markdown,
          code: result.code,
          languageMetadata: { markdown: result.metadata },
        };
      }
    }
    if (sqlParser.isSupported(code)) {
      const result = sqlParser.transformIn(code);
      return {
        kind: CODE_KIND,
        languageId: languageIds.Sql,
        code: result.code,
        languageMetadata: { sql: result.metadata },
      };
    }
  }
  return {
    kind: CODE_KIND,
    languageId: languageIds.Python,
    code,
    languageMetadata: undefined,
  };
}
