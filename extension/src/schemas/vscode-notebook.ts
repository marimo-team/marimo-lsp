import type * as vscode from "vscode";

import { Brand, Data, Effect, Option, Schema } from "effect";

import type {
  CellOperationNotification,
  VariablesNotification,
} from "../types.ts";

import { NOTEBOOK_TYPE } from "../constants.ts";
import { MarimoNotebook } from "./ir.ts";

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

export type NotebookId = Brand.Branded<string, "NotebookId">;
export type NotebookCellId = Brand.Branded<string, "NotebookCellId">;
export type VariableName = Brand.Branded<string, "VariableName">;

// Do not export constructors from this module.
//
// The only way to get our NotebookUid/CellUid type is from modules in this file
const NotebookId = Brand.nominal<NotebookId>();
const NotebookCellId = Brand.nominal<NotebookCellId>();
const VariableName = Brand.nominal<VariableName>();

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
    overrides?: Pick<Partial<CellMetadata>, "state" | "stableId">;
  }) {
    return encodeCellMetadata({ ...this.#raw.metadata, ...options?.overrides });
  }

  /**
   * Creates a MarimoNotebookCell from a VS Code NotebookCell.
   */
  static from(cell: vscode.NotebookCell) {
    return new MarimoNotebookCell(cell);
  }

  get id() {
    return this.metadata.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.stableId)),
      Option.map((stableId) => NotebookCellId(stableId)),
    );
  }

  get notebook() {
    return MarimoNotebookDocument.from(this.#raw.notebook);
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

  /**
   * A handle to the underlying untyped cell
   *
   * This should _only_ be accessed when using VS Code APIs that require the underlying type.
   */
  get rawNotebookCell() {
    return this.#raw;
  }
}

export class MarimoNotebookDocument {
  #raw: vscode.NotebookDocument;
  // we parse lazily, just the header for now... could expand when we need it
  #cachedMeta: undefined | Option.Option<Pick<MarimoNotebook, "header">>;

  private constructor(raw: vscode.NotebookDocument) {
    this.#raw = raw;
  }

  /**
   * Attempts to construct a MarimoNotebookDocument from the given raw VS Code
   * NotebookDocument. Returns `Option.none()` if the notebook type does not match.
   */
  static tryFrom(
    raw: vscode.NotebookDocument,
  ): Option.Option<MarimoNotebookDocument> {
    return raw.notebookType === NOTEBOOK_TYPE
      ? Option.some(new MarimoNotebookDocument(raw))
      : Option.none();
  }

  /**
   * Constructs a MarimoNotebookDocument from the given VS Code NotebookDocument.
   *
   * Use this when the caller expects the document to *definitely* be a Marimo
   * notebook and wants an immediate failure if it is not. This is appropriate in
   * code paths where an invalid notebook type indicates a programming error or an
   * unexpected extension state.
   *
   * If the VS Code NotebookDocument is unknown, prefer `MarimoNotebookDocument.tryFrom`
   *
   * Throws an Error if the notebook type does not match `NOTEBOOK_TYPE`.
   */
  static from(raw: vscode.NotebookDocument): MarimoNotebookDocument {
    return Option.getOrThrowWith(
      MarimoNotebookDocument.tryFrom(raw),
      () =>
        new Error(
          `Expected "${NOTEBOOK_TYPE}" document, got ${raw.notebookType}`,
        ),
    );
  }

  get #meta() {
    if (this.#cachedMeta) {
      return this.#cachedMeta;
    }
    const meta = Schema.decodeUnknownOption(MarimoNotebook.pick("header"))(
      this.#raw.metadata,
    );
    this.#cachedMeta = meta;
    return meta;
  }

  get id() {
    return NotebookId(this.#raw.uri.toString());
  }

  get header() {
    return this.#meta.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.header?.value)),
      Option.getOrElse(() => ""),
    );
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

  get isUntitled() {
    return this.#raw.isUntitled;
  }

  getCells() {
    return this.#raw.getCells().map((cell) => MarimoNotebookCell.from(cell));
  }

  cellAt(index: number) {
    return MarimoNotebookCell.from(this.#raw.cellAt(index));
  }

  save() {
    return Effect.promise(() => this.#raw.save());
  }

  get cellCount() {
    return this.#raw.cellCount;
  }

  /**
   * A handle to the underlying (untyped) document
   *
   * This should _only_ be accessed when using VS Code APIs that require a "raw" document.
   */
  get rawNotebookDocument() {
    return this.#raw;
  }
}

class NotebookCellNotFoundError extends Data.TaggedError(
  "NotebookCellNotFoundError",
)<{
  readonly cellId: NotebookCellId;
  readonly notebook: MarimoNotebookDocument;
}> {
  get message() {
    const cellIds = this.notebook.getCells().map((c) => c.id);
    return `No cell id ${this.cellId} in notebook ${this.notebook.uri.toString()}. Available cells: ${cellIds.join(
      ", ",
    )}`;
  }
}

export function extractCellIdFromCellMessage(msg: CellOperationNotification) {
  return NotebookCellId(msg.cell_id);
}

export function decodeVariablesOperation({ variables }: VariablesNotification) {
  return variables.map(
    (v) =>
      ({
        name: VariableName(v.name),
        declaredBy: v.declared_by.map((id) => NotebookCellId(id)),
        usedBy: v.used_by.map((id) => NotebookCellId(id)),
      }) as const,
  );
}

/**
 * Get a notebook cell by its id
 * @param notebook - The notebook document
 * @param cellId - The id of the cell
 * @returns The notebook cell
 * @throws An error if the cell is not found
 */
export function findNotebookCell(
  notebook: MarimoNotebookDocument,
  cellId: NotebookCellId,
) {
  return Effect.gen(function* () {
    const cell = notebook.getCells().find((c) =>
      Option.match(c.id, {
        onSome: (id) => id === cellId,
        onNone: () => false,
      }),
    );
    if (!cell) {
      return yield* new NotebookCellNotFoundError({ cellId, notebook });
    }
    return cell;
  });
}
