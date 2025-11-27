Object.defineProperty(exports, "__esModule", { value: true });
exports.encodeCellMetadata =
  exports.decodeCellMetadata =
  exports.CellMetadata =
  exports.CellLanguage =
  exports.CellState =
    void 0;
exports.isStaleCellMetadata = isStaleCellMetadata;
const effect_1 = require("effect");
const SQLMetadata = effect_1.Schema.Struct({
  dataframeName: effect_1.Schema.String,
  quotePrefix: effect_1.Schema.Literal("", "f", "r", "fr", "rf"),
  commentLines: effect_1.Schema.Array(effect_1.Schema.String),
  showOutput: effect_1.Schema.Boolean,
  engine: effect_1.Schema.String,
});
const MarkdownMetadata = effect_1.Schema.Struct({
  quotePrefix: effect_1.Schema.Literal("", "f", "r", "fr", "rf"),
});
/**
 * Cell execution state
 */
exports.CellState = effect_1.Schema.Literal(
  "idle",
  "queued",
  "running",
  "stale",
);
/**
 * Cell language
 */
exports.CellLanguage = effect_1.Schema.Literal("python", "sql", "markdown");
// TODO: passthrough unknown fields
/**
 * VS Code notebook cell metadata (runtime state)
 */
exports.CellMetadata = effect_1.Schema.partial(
  effect_1.Schema.Struct({
    // Cell execution state
    state: exports.CellState,
    // Cell name (marimo cell identifier)
    name: effect_1.Schema.String,
    // Cell configuration options
    options: effect_1.Schema.Record({
      key: effect_1.Schema.String,
      value: effect_1.Schema.Unknown,
    }),
    // Language-specific metadata (e.g., SQL engine, output flag)
    languageMetadata: effect_1.Schema.partial(
      effect_1.Schema.Struct({
        sql: SQLMetadata,
        markdown: MarkdownMetadata,
      }),
    ),
  }),
);
/**
 * Safely decode cell metadata with fallback to empty object
 */
exports.decodeCellMetadata = effect_1.Schema.decodeUnknownOption(
  exports.CellMetadata,
);
/**
 * Encode cell metadata for setting on a cell
 */
exports.encodeCellMetadata = effect_1.Schema.encodeSync(exports.CellMetadata);
/**
 * Type guard to check if cell has stale state
 */
function isStaleCellMetadata(metadata) {
  return metadata.state === "stale";
}
