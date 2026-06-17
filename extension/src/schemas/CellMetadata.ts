import { Schema } from "effect";

import { CellState } from "./CellState.ts";

/**
 * Cell language
 */
export const CellLanguage = Schema.Literal("python", "sql", "markdown");
export type CellLanguage = typeof CellLanguage.Type;

const SQLMetadata = Schema.Struct({
  dataframeName: Schema.String,
  quotePrefix: Schema.Literal("", "f", "r", "fr", "rf"),
  commentLines: Schema.Array(Schema.String),
  showOutput: Schema.Boolean,
  engine: Schema.String,
});

const MarkdownMetadata = Schema.Struct({
  quotePrefix: Schema.Literal("", "f", "r", "fr", "rf"),
});

/**
 * Language-specific metadata (e.g. SQL engine/output flag, markdown quoting)
 * needed to wrap a smart cell's display code back into Python. Shared with the
 * transaction planner so its cell equivalence accounts for it.
 */
export const LanguageMetadata = Schema.partial(
  Schema.Struct({
    sql: SQLMetadata,
    markdown: MarkdownMetadata,
  }),
);
export type LanguageMetadata = typeof LanguageMetadata.Type;

// TODO: passthrough unknown fields
/**
 * VS Code notebook cell metadata (runtime state)
 */
export const CellMetadata = Schema.partial(
  Schema.Struct({
    // Cell execution state
    state: CellState,

    // Cell name (marimo cell identifier)
    name: Schema.String,

    // Cell configuration options
    options: Schema.Record({
      key: Schema.String,
      value: Schema.Unknown,
    }),

    // Language-specific metadata (e.g., SQL engine, output flag)
    languageMetadata: LanguageMetadata,

    // Stable ID for tracking cells across re-deserializations
    // This is ephemeral (not persisted to .py file) and regenerated on file open
    stableId: Schema.String,
  }),
);

export type CellMetadata = typeof CellMetadata.Type;

/**
 * Safely decode cell metadata with fallback to empty object
 */
export const decodeCellMetadata = Schema.decodeUnknownOption(CellMetadata);

/**
 * Encode cell metadata for setting on a cell
 */
export const encodeCellMetadata = Schema.encodeSync(CellMetadata);
