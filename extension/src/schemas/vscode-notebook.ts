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
  #meta: Option.Option<CellMetadata>;

  private constructor(
    raw: vscode.NotebookCell,
    meta: Option.Option<CellMetadata>,
  ) {
    this.#raw = raw;
    this.#meta = meta;
  }

  encodeCellMetadata(options: { overrides: Partial<CellMetadata> }) {
    // Encode the "raw metadata"
    return encodeCellMetadata({ ...this.#raw.metadata, ...options.overrides });
  }

  static fromVsCode(cell: vscode.NotebookCell) {
    return new MarimoNotebookCell(cell, decodeCellMetadata(cell.metadata));
  }

  get notebook() {
    return new MarimoNotebookDocument(this.#raw.notebook);
  }

  get metadata() {
    return this.#meta;
  }

  get isStale() {
    return this.#meta.pipe(
      Option.map((meta) => meta.state === "stale"),
      Option.getOrElse(() => false),
    );
  }

  get languageMetadata() {
    return this.#meta.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.languageMetadata)),
    );
  }

  get name() {
    return this.#meta.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.name)),
    );
  }

  get kind() {
    return this.#raw.kind;
  }

  get index() {
    return this.#raw.index;
  }

  get document() {
    return this.#raw.document;
  }

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
    return this.#raw
      .getCells()
      .map((cell) => MarimoNotebookCell.fromVsCode(cell));
  }

  cellAt(index: number) {
    return MarimoNotebookCell.fromVsCode(this.#raw.cellAt(index));
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
