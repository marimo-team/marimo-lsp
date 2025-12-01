import { Option, Schema } from "effect";
import type * as vscode from "vscode";
import { NOTEBOOK_TYPE } from "../constants.ts";

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
 * Cell execution state
 */
export const CellState = Schema.Literal("idle", "queued", "running", "stale");
export type CellState = typeof CellState.Type;

/**
 * Cell language
 */
export const CellLanguage = Schema.Literal("python", "sql", "markdown");
export type CellLanguage = typeof CellLanguage.Type;

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
    languageMetadata: Schema.partial(
      Schema.Struct({
        sql: SQLMetadata,
        markdown: MarkdownMetadata,
      }),
    ),

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

export class MarimoNotebookCell {
  #raw: vscode.NotebookCell;
  // we parse lazily
  #cachedMeta: undefined | Option.Option<CellMetadata>;

  private constructor(raw: vscode.NotebookCell) {
    this.#raw = raw;
  }

  /**
   * Builds the encoded metadata object for this cell.
   *
   * Applies optional overrides (currently only the `state` property),
   * then produces the encoded metadata object used by the serialization
   * layer. This method does not perform string serialization; it only
   * constructs the encoded metadata representation.
   *
   * @param options - Optional metadata override configuration.
   * @returns The encoded metadata object.
   */
  buildEncodedMetadata(options?: {
    // TODO: Just shallow. Support deeper / fully recursive overrides when needed
    overrides?: Pick<Partial<CellMetadata>, "state">;
  }) {
    return encodeCellMetadata({ ...this.#raw.metadata, ...options?.overrides });
  }

  /**
   * Creates a MarimoNotebookCell from a VS Code NotebookCell.
   */
  static from(cell: vscode.NotebookCell) {
    return new MarimoNotebookCell(cell);
  }

  /**
   * The notebook this cell belongs to.
   */
  get notebook() {
    return new MarimoNotebookDocument(this.#raw.notebook);
  }

  /**
   * The decoded metadata for this cell.
   */
  get metadata() {
    if (this.#cachedMeta) {
      return this.#cachedMeta;
    }
    this.#cachedMeta = decodeCellMetadata(this.#raw.metadata);
    return this.#cachedMeta;
  }

  /**
   * Whether the cell is marked as stale.
   */
  get isStale() {
    return this.metadata.pipe(
      Option.map((meta) => meta.state === "stale"),
      Option.getOrElse(() => false),
    );
  }

  /**
   * The cell's language metadata, if present.
   */
  get languageMetadata() {
    return this.metadata.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.languageMetadata)),
    );
  }

  /**
   * The cell's name, if present.
   */
  get name() {
    return this.metadata.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.name)),
    );
  }

  /**
   * The underlying cell kind.
   */
  get stableId() {
    return this.metadata.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.stableId)),
    );
  }

  get kind() {
    return this.#raw.kind;
  }

  /**
   * The cell's index within the notebook.
   */
  get index() {
    return this.#raw.index;
  }

  /**
   * The cell's text document.
   */
  get document() {
    return this.#raw.document;
  }

  /**
   * The cell's output items.
   */
  get outputs() {
    return this.#raw.outputs;
  }
}

export class MarimoNotebookDocument {
  #raw: vscode.NotebookDocument;

  constructor(raw: vscode.NotebookDocument) {
    this.#raw = raw;
  }

  static decodeUnknownNotebookDocument(
    raw: vscode.NotebookDocument,
  ): Option.Option<MarimoNotebookDocument> {
    return raw.notebookType === NOTEBOOK_TYPE
      ? Option.some(new MarimoNotebookDocument(raw))
      : Option.none();
  }

  get rawMetadata() {
    return this.#raw.metadata;
  }

  get notebookType() {
    return NOTEBOOK_TYPE;
  }

  get uri() {
    return this.#raw.uri;
  }

  getCells() {
    return this.#raw.getCells().map((cell) => MarimoNotebookCell.from(cell));
  }

  cellAt(index: number) {
    return MarimoNotebookCell.from(this.#raw.cellAt(index));
  }

  get cellCount() {
    return this.#raw.cellCount;
  }

  /**
   * Get a handle to the underlying untyped document
   *
   * This should only be accessed when using VS Code APIs that require a "raw" document.
   */
  get unsafeRawNotebookDocument() {
    return this.#raw;
  }
}
