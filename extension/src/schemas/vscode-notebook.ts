import { Schema } from "effect";

/**
 * Cell execution state
 */
export const CellState = Schema.Literal("idle", "queued", "running", "stale");
export type CellState = typeof CellState.Type;

/**
 * Cell language
 */
export const CellLanguage = Schema.Literal("python", "sql");
export type CellLanguage = typeof CellLanguage.Type;

// TODO: passthrough unknown fields
/**
 * VS Code notebook cell metadata (runtime state)
 */
export const CellMetadata = Schema.Struct({
  // Cell execution state
  state: CellState.pipe(Schema.optional),

  // Cell name (marimo cell identifier)
  name: Schema.String.pipe(Schema.optional),

  // Cell configuration options
  options: Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  }).pipe(Schema.optional),

  // Cell language (for smart-cells support)
  language: CellLanguage.pipe(Schema.optional),

  // Language-specific metadata (e.g., SQL engine, output flag)
  languageMetadata: Schema.Record({
    key: Schema.String,
    value: Schema.Unknown,
  }).pipe(Schema.optional),
});

export type CellMetadata = typeof CellMetadata.Type;

/**
 * Safely decode cell metadata with fallback to empty object
 */
export const decodeCellMetadata = Schema.decodeUnknownOption(CellMetadata);

/**
 * Encode cell metadata for setting on a cell
 */
export const encodeCellMetadata = Schema.encodeSync(CellMetadata);

/**
 * Type guard to check if cell has stale state
 */
export function isStaleCellMetadata(
  metadata: CellMetadata,
): metadata is CellMetadata & { state: "stale" } {
  return metadata.state === "stale";
}

/**
 * Type guard to check if cell has a specific state
 */
export function hasCellState(
  metadata: CellMetadata,
  state: CellState,
): boolean {
  return metadata.state === state;
}

/**
 * Helper to create cell metadata with validation
 */
export function createCellMetadata(
  partial: Partial<CellMetadata>,
): CellMetadata {
  return encodeCellMetadata(partial);
}
