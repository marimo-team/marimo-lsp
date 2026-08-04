import { Brand, Data, Effect, Option, Schema } from "effect";
import type * as vscode from "vscode";

import { NOTEBOOK_TYPE } from "../constants.ts";
import type {
  CellOperationNotification,
  VariablesNotification,
  CellId,
  VariableName,
} from "../types.ts";
import * as Api from "./Models.gen.ts";

export type NotebookId = Brand.Branded<string, "NotebookId">;
export type NotebookCellId = CellId;

const NotebookId = Brand.nominal<NotebookId>();
// SAFETY: brand smart constructors for TypedString<"CellId"> / TypedString<"VariableName">
// (openapi codegen types, not Effect Brand). No runtime check — callers pass
// strings originating from the LSP's typed responses.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const NotebookCellId = (id: string) => id as CellId;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion
const VariableName = (name: string) => name as VariableName;

const decodeCellMetadata = Schema.decodeUnknownOption(Api.CellMetadata);
const decodeCellMetadataSync = Schema.decodeUnknownSync(Api.CellMetadata);
const encodeCellMetadata = Schema.encodeSync(Api.CellMetadata);
const marimoCellMetadataEquivalence = Schema.equivalence(
  Api.MarimoCellMetadata,
);
const runtimeMetadataEquivalence = Schema.equivalence(
  Api.MarimoCellRuntimeMetadata,
);
const decodeNotebookMetadata = Schema.decodeUnknownOption(
  Api.MarimoNotebookMetadata,
);
const parseNotebookMetadata = Schema.decodeUnknown(Api.MarimoNotebookMetadata);
const decodeNotebookMetadataSync = Schema.decodeUnknownSync(
  Api.MarimoNotebookMetadata,
);
const encodeNotebookMetadata = Schema.encodeSync(Api.MarimoNotebookMetadata);
const notebookMetadataEquivalence = Schema.equivalence(
  Api.MarimoNotebookMetadata,
);

const parseOwnedAppConfig = Schema.decodeUnknown(Api.OwnedAppConfig);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Schema that decodes a string into a branded {@link NotebookId}.
 *
 * Only use this for parsing data from external sources (e.g., debug
 * configurations, serialized state). Prefer obtaining NotebookId values
 * from {@link MarimoNotebookDocument.id} in normal code paths.
 */
export const NotebookIdFromString = Schema.String.pipe(
  Schema.fromBrand(NotebookId),
);

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

export class MarimoNotebookCell {
  #raw: vscode.NotebookCell;
  // we parse lazily
  #cachedMeta: undefined | Option.Option<Api.CellMetadata>;

  private constructor(raw: vscode.NotebookCell) {
    this.#raw = raw;
  }

  /** Build runtime metadata while completing an already-dirty insertion. */
  buildRuntimeMetadataForInsertion(
    overrides: Pick<Partial<Api.MarimoCellRuntimeMetadata>, "stableId">,
  ) {
    return MarimoNotebookCell.materializeRuntimeMetadata(
      this.#raw.metadata,
      overrides,
    );
  }

  buildMarimoMetadataUpdate(metadata: Api.MarimoCellMetadata) {
    const current = decodeCellMetadataSync(this.#raw.metadata);
    const next = decodeCellMetadataSync({
      ...current,
      marimo: metadata,
    });
    if (marimoCellMetadataEquivalence(current.marimo, next.marimo)) {
      return this.#raw.metadata;
    }
    return encodeCellMetadata(next);
  }

  /** Encode complete metadata for a newly-created cell. */
  static createMetadata(value: typeof Api.CellMetadata.Encoded) {
    return encodeCellMetadata(decodeCellMetadataSync(value));
  }

  /** Decode the generated metadata model from an open LSP metadata envelope. */
  static decodeMetadata(value: unknown) {
    return decodeCellMetadata(value);
  }

  /**
   * Carry runtime metadata through deserialization, insertion, or replacement.
   * Never use this to submit a runtime-only edit against a clean existing cell.
   */
  static materializeRuntimeMetadata(
    raw: unknown,
    updates: Partial<Api.MarimoCellRuntimeMetadata>,
  ) {
    const current = decodeCellMetadataSync(asRecord(raw));
    const next = decodeCellMetadataSync({
      ...current,
      marimoRuntime: { ...current.marimoRuntime, ...updates },
    });
    if (runtimeMetadataEquivalence(current.marimoRuntime, next.marimoRuntime)) {
      return asRecord(raw);
    }
    return encodeCellMetadata(next);
  }

  /** Retain inactive source projections while materializing notebook data. */
  static retainSourceProjections(
    raw: unknown,
    retained: Api.CellSourceProjections,
  ) {
    const current = decodeCellMetadataSync(asRecord(raw));
    return encodeCellMetadata(
      decodeCellMetadataSync({
        ...current,
        marimo: {
          ...current.marimo,
          sourceProjections: {
            markdown:
              current.marimo.sourceProjections.markdown ?? retained.markdown,
            sql: current.marimo.sourceProjections.sql ?? retained.sql,
          },
        },
      }),
    );
  }

  /** Replace both owned namespaces while an existing cell is being replaced. */
  buildMetadataForReplacement(
    marimo: Api.MarimoCellMetadata,
    runtime: Partial<Api.MarimoCellRuntimeMetadata>,
  ) {
    const current = decodeCellMetadataSync(this.#raw.metadata);
    return encodeCellMetadata(
      decodeCellMetadataSync({
        ...current,
        marimo,
        marimoRuntime: { ...current.marimoRuntime, ...runtime },
      }),
    );
  }

  /**
   * Creates a MarimoNotebookCell from a VS Code NotebookCell.
   */
  static from(cell: vscode.NotebookCell) {
    return new MarimoNotebookCell(cell);
  }

  get id() {
    return this.metadata.pipe(
      Option.flatMap((meta) =>
        Option.fromNullable(meta.marimoRuntime.stableId),
      ),
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
      Option.map((meta) => meta.marimoRuntime.state === "stale"),
      Option.getOrElse(() => false),
    );
  }

  /**
   * Whether the cell is disabled via `@app.cell(disabled=True)`.
   *
   * marimo stores the decorator's `disabled` flag in the cell's config; the
   * LSP deserialize path surfaces it as `metadata.options.disabled`. Disabled
   * cells must not be sent for execution (issue #154).
   */
  get isDisabled() {
    return this.metadata.pipe(
      Option.map((meta) => meta.marimo.options.disabled === true),
      Option.getOrElse(() => false),
    );
  }

  /**
   * Whether the cell's code is hidden via `@app.cell(hide_code=True)`.
   *
   * marimo stores the decorator's `hide_code` flag in the cell's config; the
   * LSP deserialize path surfaces it as `metadata.options.hide_code`. VS Code
   * has no API to read or set the input-collapsed state, so this is the source
   * of truth for the one-way synchronization performed by
   * {@link CellInputVisibilitySyncLive} (issue #326).
   */
  get isCodeHidden() {
    return this.metadata.pipe(
      Option.map((meta) => meta.marimo.options.hide_code === true),
      Option.getOrElse(() => false),
    );
  }

  /**
   * The cell's language metadata, if present.
   */
  get sourceProjections() {
    return this.metadata.pipe(
      Option.flatMap((meta) =>
        Option.fromNullable(meta.marimo.sourceProjections),
      ),
    );
  }

  /**
   * The cell's name, if present.
   */
  get name() {
    return this.metadata.pipe(Option.map((meta) => meta.marimo.name));
  }

  get stableId() {
    return this.metadata.pipe(
      Option.flatMap((meta) =>
        Option.fromNullable(meta.marimoRuntime.stableId),
      ),
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
   * The cell's most recent VS Code execution summary.
   */
  get executionSummary() {
    return this.#raw.executionSummary;
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
  #cachedMeta: undefined | Option.Option<Api.MarimoNotebookMetadata>;

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
    const raw = asRecord(this.#raw.metadata);
    const meta =
      raw.marimo === undefined
        ? Option.none<Api.MarimoNotebookMetadata>()
        : decodeNotebookMetadata(raw.marimo);
    this.#cachedMeta = meta;
    return meta;
  }

  get id() {
    // The LSP server keys notebook documents by the URI from notebookDocument/didOpen,
    // which VS Code sends without percent-encoding. We should match that form here.
    return NotebookId(this.#raw.uri.toString(/* skipEncoding */ true));
  }

  get header() {
    return this.#meta.pipe(
      Option.flatMap((meta) => Option.fromNullable(meta.header)),
      Option.getOrElse(() => ""),
    );
  }

  /** Parse persisted metadata for operations that must not continue on corruption. */
  parseMetadata() {
    const raw = asRecord(this.#raw.metadata);
    return parseNotebookMetadata(
      Object.hasOwn(raw, "marimo") ? raw.marimo : {},
    ).pipe(
      Effect.flatMap((metadata) =>
        parseOwnedAppConfig(metadata.appConfig).pipe(
          Effect.map((appConfig) => ({ ...metadata, appConfig })),
        ),
      ),
    );
  }

  get rawMetadata() {
    return this.#raw.metadata;
  }

  /** Encode canonical metadata for a newly-created notebook document. */
  static createMetadata(value: typeof Api.MarimoNotebookMetadata.Encoded) {
    const marimo = decodeNotebookMetadataSync(value);
    return Schema.encodeSync(Api.NotebookDocumentMetadata)({ marimo });
  }

  /** Replace persisted notebook metadata, preserving foreign host properties. */
  buildMetadataUpdate(
    updates: Partial<typeof Api.MarimoNotebookMetadata.Encoded>,
  ) {
    const root = asRecord(this.#raw.metadata);
    const current = decodeNotebookMetadataSync(
      Object.hasOwn(root, "marimo") ? root.marimo : {},
    );
    const next = decodeNotebookMetadataSync({ ...current, ...updates });
    if (
      root.marimo !== undefined &&
      notebookMetadataEquivalence(current, next)
    ) {
      return this.#raw.metadata;
    }
    return { ...root, marimo: encodeNotebookMetadata(next) };
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
