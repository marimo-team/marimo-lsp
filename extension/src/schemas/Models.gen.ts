// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `src/marimo_lsp/protocol.py`, `src/marimo_lsp/models.py`,
// and the command registry (`COMMANDS` in `src/marimo_lsp/api.py`)
// by `scripts.codegen`.
// Regenerate with `just codegen`.
import type { components as MarimoApi } from "@marimo-team/openapi/src/api";
import { Effect, Schema } from "effect";

type MarimoNotification = MarimoApi["schemas"]["KnownUnions"]["notification"];
const MarimoNotification = Schema.declare<MarimoNotification>(
  (value): value is MarimoNotification =>
    typeof value === "object" &&
    value !== null &&
    "op" in value &&
    typeof value.op === "string",
);

type CellOperationNotification = Extract<MarimoNotification, { op: "cell-op" }>;
const CellOperationNotification = Schema.declare<CellOperationNotification>(
  (value): value is CellOperationNotification =>
    Schema.is(MarimoNotification)(value) && value.op === "cell-op",
);

type VariablesNotification = Extract<MarimoNotification, { op: "variables" }>;
const VariablesNotification = Schema.declare<VariablesNotification>(
  (value): value is VariablesNotification =>
    Schema.is(MarimoNotification)(value) && value.op === "variables",
);

// The id is an opaque token minted by the server; only equality matters.
// Validating its shape here would turn a harmless server-side format
// change into silently dropped notifications.
export const KernelSessionIdFromString = Schema.String.pipe(
  Schema.brand("KernelSessionId"),
);
export type KernelSessionId = typeof KernelSessionIdFromString.Type;

export const NotebookIdFromString = Schema.String.pipe(
  Schema.brand("NotebookId"),
);
export type NotebookId = typeof NotebookIdFromString.Type;

export const NotebookUriFromString = Schema.String.pipe(
  Schema.brand("NotebookUri"),
);
export type NotebookUri = typeof NotebookUriFromString.Type;

export const CellIdFromString = Schema.String.pipe(Schema.brand("CellId"));
export type CellId = typeof CellIdFromString.Type;

/**
 * One cell and the exact source to execute for it.
 */
export const CellExecution = Schema.Struct({
  cellId: CellIdFromString,
  code: Schema.String,
}).annotate({
  identifier: "CellExecution",
  parseOptions: { onExcessProperty: "error" },
});
export type CellExecution = typeof CellExecution.Type;

/**
 * Execute a batch of notebook cells, starting its kernel if necessary.
 */
export const Execute = Schema.Struct({
  kind: Schema.Literal("execute"),
  notebookUri: NotebookUriFromString,
  executable: Schema.String,
  workingDirectory: Schema.String,
  cells: Schema.Array(CellExecution),
}).annotate({
  identifier: "Execute",
  parseOptions: { onExcessProperty: "error" },
});
export type Execute = typeof Execute.Type;

/**
 * Update one or more UI element values in an exact kernel.
 */
export const UpdateUiElement = Schema.Struct({
  kind: Schema.Literal("update-ui-element"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: KernelSessionIdFromString,
  objectIds: Schema.Array(Schema.String),
  values: Schema.Array(Schema.Unknown),
  request: Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown)).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  token: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "UpdateUiElement",
  parseOptions: { onExcessProperty: "error" },
});
export type UpdateUiElement = typeof UpdateUiElement.Type;

/**
 * State update sent to one widget model.
 */
export const ModelUpdateMessage = Schema.Struct({
  method: Schema.Literal("update"),
  state: Schema.Record(Schema.String, Schema.Unknown),
  bufferPaths: Schema.Array(
    Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  ),
}).annotate({
  identifier: "ModelUpdateMessage",
  parseOptions: { onExcessProperty: "error" },
});
export type ModelUpdateMessage = typeof ModelUpdateMessage.Type;

/**
 * Custom message sent to one widget model.
 */
export const ModelCustomMessage = Schema.Struct({
  method: Schema.Literal("custom"),
  content: Schema.Unknown,
}).annotate({
  identifier: "ModelCustomMessage",
  parseOptions: { onExcessProperty: "error" },
});
export type ModelCustomMessage = typeof ModelCustomMessage.Type;

/**
 * Base64-encoded bytes on the msgspec JSON wire.
 *
 * Matches the compile-time `TypedString<"Base64String">` brand emitted
 * by `@marimo-team/openapi`. Decode with `Schema.Uint8ArrayFromBase64`
 * where actual bytes are needed.
 */
export const Base64String = Schema.String.pipe(Schema.brand("Base64String"));
export type Base64String = typeof Base64String.Type;

/**
 * Update state for one widget model in an exact kernel.
 */
export const SetModelValue = Schema.Struct({
  kind: Schema.Literal("set-model-value"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: KernelSessionIdFromString,
  modelId: Schema.String,
  message: Schema.Union([ModelUpdateMessage, ModelCustomMessage]),
  buffers: Schema.Array(Base64String),
  token: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "SetModelValue",
  parseOptions: { onExcessProperty: "error" },
});
export type SetModelValue = typeof SetModelValue.Type;

/**
 * Invoke a registered function in an exact kernel.
 */
export const InvokeFunction = Schema.Struct({
  kind: Schema.Literal("invoke-function"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: KernelSessionIdFromString,
  functionCallId: Schema.String,
  namespace: Schema.String,
  functionName: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({
  identifier: "InvokeFunction",
  parseOptions: { onExcessProperty: "error" },
});
export type InvokeFunction = typeof InvokeFunction.Type;

/**
 * Interrupt an exact kernel or cancel a pending scratch execution.
 */
export const Interrupt = Schema.Struct({
  kind: Schema.Literal("interrupt"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: Schema.NullOr(KernelSessionIdFromString).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  runId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "Interrupt",
  parseOptions: { onExcessProperty: "error" },
});
export type Interrupt = typeof Interrupt.Type;

/**
 * Remove one cell from the exact live kernel that owns it.
 */
export const DeleteCell = Schema.Struct({
  kind: Schema.Literal("delete-cell"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: KernelSessionIdFromString,
  cellId: CellIdFromString,
}).annotate({
  identifier: "DeleteCell",
  parseOptions: { onExcessProperty: "error" },
});
export type DeleteCell = typeof DeleteCell.Type;

/**
 * List immediate child schemas at a database path.
 */
export const ListSqlSchemas = Schema.Struct({
  kind: Schema.Literal("list-sql-schemas"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: KernelSessionIdFromString,
  requestId: Schema.String,
  engine: Schema.String,
  database: Schema.String,
  schemaPath: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
}).annotate({
  identifier: "ListSqlSchemas",
  parseOptions: { onExcessProperty: "error" },
});
export type ListSqlSchemas = typeof ListSqlSchemas.Type;

/**
 * List tables in one database schema.
 */
export const ListSqlTables = Schema.Struct({
  kind: Schema.Literal("list-sql-tables"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: KernelSessionIdFromString,
  requestId: Schema.String,
  engine: Schema.String,
  database: Schema.String,
  schema: Schema.String,
  schemaPath: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
}).annotate({
  identifier: "ListSqlTables",
  parseOptions: { onExcessProperty: "error" },
});
export type ListSqlTables = typeof ListSqlTables.Type;

/**
 * Respond to a stdin prompt in an exact kernel.
 */
export const SendStdin = Schema.Struct({
  kind: Schema.Literal("send-stdin"),
  notebookUri: NotebookUriFromString,
  kernelSessionId: KernelSessionIdFromString,
  text: Schema.String,
}).annotate({
  identifier: "SendStdin",
  parseOptions: { onExcessProperty: "error" },
});
export type SendStdin = typeof SendStdin.Type;

/**
 * Close the live session for one notebook.
 */
export const CloseSession = Schema.Struct({
  kind: Schema.Literal("close-session"),
  notebookUri: NotebookUriFromString,
}).annotate({
  identifier: "CloseSession",
  parseOptions: { onExcessProperty: "error" },
});
export type CloseSession = typeof CloseSession.Type;

/**
 * Restart or restore the live session for one notebook.
 */
export const RestartSession = Schema.Struct({
  kind: Schema.Literal("restart-session"),
  notebookUri: NotebookUriFromString,
  executable: Schema.String,
  workingDirectory: Schema.String,
  createIfMissing: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.sync(() => false)),
  ),
}).annotate({
  identifier: "RestartSession",
  parseOptions: { onExcessProperty: "error" },
});
export type RestartSession = typeof RestartSession.Type;

/**
 * Move a live session after its notebook is renamed.
 */
export const MoveSession = Schema.Struct({
  kind: Schema.Literal("move-session"),
  notebookUri: NotebookUriFromString,
  newNotebookUri: NotebookUriFromString,
}).annotate({
  identifier: "MoveSession",
  parseOptions: { onExcessProperty: "error" },
});
export type MoveSession = typeof MoveSession.Type;

/**
 * List all live sessions owned by the language server.
 */
export const ListSessions = Schema.Struct({
  kind: Schema.Literal("list-sessions"),
}).annotate({
  identifier: "ListSessions",
  parseOptions: { onExcessProperty: "error" },
});
export type ListSessions = typeof ListSessions.Type;

/**
 * Close every live session owned by the language server.
 */
export const ShutdownAllSessions = Schema.Struct({
  kind: Schema.Literal("shutdown-all-sessions"),
}).annotate({
  identifier: "ShutdownAllSessions",
  parseOptions: { onExcessProperty: "error" },
});
export type ShutdownAllSessions = typeof ShutdownAllSessions.Type;

/**
 * Execute transient code against a notebook kernel.
 */
export const ExecuteScratchpad = Schema.Struct({
  kind: Schema.Literal("execute-scratchpad"),
  notebookUri: NotebookUriFromString,
  executable: Schema.String,
  workingDirectory: Schema.String,
  code: Schema.String,
  runId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "ExecuteScratchpad",
  parseOptions: { onExcessProperty: "error" },
});
export type ExecuteScratchpad = typeof ExecuteScratchpad.Type;

/**
 * A concrete environment identified by its Python executable.
 */
export const VenvSource = Schema.Struct({
  kind: Schema.Literal("venv"),
  executable: Schema.String,
}).annotate({
  identifier: "VenvSource",
  parseOptions: { onExcessProperty: "error" },
});
export type VenvSource = typeof VenvSource.Type;

/**
 * A PEP 723 environment resolved from the notebook script.
 */
export const ScriptSource = Schema.Struct({
  kind: Schema.Literal("script"),
}).annotate({
  identifier: "ScriptSource",
  parseOptions: { onExcessProperty: "error" },
});
export type ScriptSource = typeof ScriptSource.Type;

/**
 * List packages installed in a notebook environment.
 */
export const ListPackages = Schema.Struct({
  kind: Schema.Literal("list-packages"),
  notebookUri: NotebookUriFromString,
  source: Schema.Union([VenvSource, ScriptSource]),
}).annotate({
  identifier: "ListPackages",
  parseOptions: { onExcessProperty: "error" },
});
export type ListPackages = typeof ListPackages.Type;

/**
 * Read the dependency tree for a notebook environment.
 */
export const GetDependencyTree = Schema.Struct({
  kind: Schema.Literal("get-dependency-tree"),
  notebookUri: NotebookUriFromString,
  source: Schema.Union([VenvSource, ScriptSource]),
}).annotate({
  identifier: "GetDependencyTree",
  parseOptions: { onExcessProperty: "error" },
});
export type GetDependencyTree = typeof GetDependencyTree.Type;

/**
 * Opaque-compatible metadata stored with a notebook document.
 */
export const NotebookMetadata = Schema.Struct({
  marimo_version: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "NotebookMetadata" });
export type NotebookMetadata = typeof NotebookMetadata.Type;

/**
 * Persisted marimo configuration for one notebook cell.
 */
export const NotebookCellConfig = Schema.Struct({
  column: Schema.optional(Schema.NullOr(Schema.Int)),
  disabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hide_code: Schema.optional(Schema.NullOr(Schema.Boolean)),
}).annotate({ identifier: "NotebookCellConfig" });
export type NotebookCellConfig = typeof NotebookCellConfig.Type;

/**
 * One code cell in an owned notebook document.
 */
export const NotebookCell = Schema.Struct({
  code: Schema.NullOr(Schema.String),
  code_hash: Schema.NullOr(Schema.String),
  config: NotebookCellConfig,
  id: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
}).annotate({ identifier: "NotebookCell" });
export type NotebookCell = typeof NotebookCell.Type;

/**
 * Source-level app options managed by the extension.
 */
export const ManagedAppOptions = Schema.Struct({
  autoDownload: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
}).annotate({
  identifier: "ManagedAppOptions",
  parseOptions: { onExcessProperty: "error" },
});
export type ManagedAppOptions = typeof ManagedAppOptions.Type;

/**
 * Managed app options plus an opaque lossless passthrough bag.
 */
export const AppOptions = Schema.Struct({
  managed: ManagedAppOptions.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  passthrough: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
}).annotate({
  identifier: "AppOptions",
  parseOptions: { onExcessProperty: "error" },
});
export type AppOptions = typeof AppOptions.Type;

/**
 * Owned notebook data plus source-level application metadata.
 */
export const NotebookDocument = Schema.Struct({
  version: Schema.Literal("1"),
  metadata: NotebookMetadata,
  cells: Schema.Array(NotebookCell),
  appOptions: AppOptions.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  header: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "NotebookDocument",
  parseOptions: { onExcessProperty: "error" },
});
export type NotebookDocument = typeof NotebookDocument.Type;

/**
 * Print an owned notebook document as native marimo Python source.
 */
export const PrintNotebook = Schema.Struct({
  kind: Schema.Literal("print-notebook"),
  document: NotebookDocument,
}).annotate({
  identifier: "PrintNotebook",
  parseOptions: { onExcessProperty: "error" },
});
export type PrintNotebook = typeof PrintNotebook.Type;

/**
 * Parse native marimo Python source into an owned notebook document.
 */
export const ParseNotebook = Schema.Struct({
  kind: Schema.Literal("parse-notebook"),
  source: Schema.String,
}).annotate({
  identifier: "ParseNotebook",
  parseOptions: { onExcessProperty: "error" },
});
export type ParseNotebook = typeof ParseNotebook.Type;

/**
 * Read configuration for one notebook.
 */
export const GetConfiguration = Schema.Struct({
  kind: Schema.Literal("get-configuration"),
  notebookUri: NotebookUriFromString,
}).annotate({
  identifier: "GetConfiguration",
  parseOptions: { onExcessProperty: "error" },
});
export type GetConfiguration = typeof GetConfiguration.Type;

/**
 * Merge a configuration patch for one notebook.
 */
export const UpdateConfiguration = Schema.Struct({
  kind: Schema.Literal("update-configuration"),
  notebookUri: NotebookUriFromString,
  config: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({
  identifier: "UpdateConfiguration",
  parseOptions: { onExcessProperty: "error" },
});
export type UpdateConfiguration = typeof UpdateConfiguration.Type;

/**
 * Set the display theme for live sessions.
 */
export const SetDisplayTheme = Schema.Struct({
  kind: Schema.Literal("set-display-theme"),
  theme: Schema.Literals(["dark", "light"]),
}).annotate({
  identifier: "SetDisplayTheme",
  parseOptions: { onExcessProperty: "error" },
});
export type SetDisplayTheme = typeof SetDisplayTheme.Type;

/**
 * Read outputs without starting a notebook kernel.
 */
export const ReadNotebookOutputs = Schema.Struct({
  kind: Schema.Literal("read-notebook-outputs"),
  notebookUri: NotebookUriFromString,
  sessionCachePath: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "ReadNotebookOutputs",
  parseOptions: { onExcessProperty: "error" },
});
export type ReadNotebookOutputs = typeof ReadNotebookOutputs.Type;

/**
 * Export one notebook as HTML.
 */
export const ExportHtml = Schema.Struct({
  kind: Schema.Literal("export-html"),
  notebookUri: NotebookUriFromString,
  download: Schema.Boolean,
  files: Schema.Array(Schema.String),
  includeCode: Schema.Boolean,
  assetUrl: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "ExportHtml",
  parseOptions: { onExcessProperty: "error" },
});
export type ExportHtml = typeof ExportHtml.Type;

/**
 * Export one notebook as ipynb JSON.
 */
export const ExportIpynb = Schema.Struct({
  kind: Schema.Literal("export-ipynb"),
  notebookUri: NotebookUriFromString,
}).annotate({
  identifier: "ExportIpynb",
  parseOptions: { onExcessProperty: "error" },
});
export type ExportIpynb = typeof ExportIpynb.Type;

/**
 * Export one notebook as Markdown.
 */
export const ExportMarkdown = Schema.Struct({
  kind: Schema.Literal("export-markdown"),
  notebookUri: NotebookUriFromString,
}).annotate({
  identifier: "ExportMarkdown",
  parseOptions: { onExcessProperty: "error" },
});
export type ExportMarkdown = typeof ExportMarkdown.Type;

export const Command = Schema.Union([
  Execute,
  UpdateUiElement,
  SetModelValue,
  InvokeFunction,
  Interrupt,
  DeleteCell,
  ListSqlSchemas,
  ListSqlTables,
  SendStdin,
  CloseSession,
  RestartSession,
  MoveSession,
  ListSessions,
  ShutdownAllSessions,
  ExecuteScratchpad,
  ListPackages,
  GetDependencyTree,
  PrintNotebook,
  ParseNotebook,
  GetConfiguration,
  UpdateConfiguration,
  SetDisplayTheme,
  ReadNotebookOutputs,
  ExportHtml,
  ExportIpynb,
  ExportMarkdown,
]).annotate({ identifier: "Command" });
export type Command = typeof Command.Type;

/**
 * A notification emitted by one exact live kernel.
 */
export const KernelNotification = Schema.Struct({
  notebookUri: NotebookIdFromString,
  sessionId: KernelSessionIdFromString,
  notification: MarimoNotification,
}).annotate({ identifier: "KernelNotification" });
export type KernelNotification = typeof KernelNotification.Type;

/**
 * Analysis derived from a notebook document without a live kernel.
 */
export const DocumentAnalysis = Schema.Struct({
  notebookUri: NotebookIdFromString,
  analysis: VariablesNotification,
}).annotate({ identifier: "DocumentAnalysis" });
export type DocumentAnalysis = typeof DocumentAnalysis.Type;

/**
 * Projection state for displaying a Python markdown cell.
 */
export const MarkdownCellProjection = Schema.Struct({
  quotePrefix: Schema.Literals(["", "f", "fr", "r", "rf"]).pipe(
    Schema.withDecodingDefault(Effect.sync(() => "r")),
  ),
}).annotate({
  identifier: "MarkdownCellProjection",
  parseOptions: { onExcessProperty: "error" },
});
export type MarkdownCellProjection = typeof MarkdownCellProjection.Type;

/**
 * Projection state for displaying a Python SQL cell.
 */
export const SqlCellProjection = Schema.Struct({
  dataframeName: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.sync(() => "_df")),
  ),
  quotePrefix: Schema.Literals(["", "f", "fr", "r", "rf"]).pipe(
    Schema.withDecodingDefault(Effect.sync(() => "f")),
  ),
  commentLines: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
  showOutput: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.sync(() => true)),
  ),
  engine: Schema.String.pipe(
    Schema.withDecodingDefault(Effect.sync(() => "__marimo_duckdb")),
  ),
}).annotate({
  identifier: "SqlCellProjection",
  parseOptions: { onExcessProperty: "error" },
});
export type SqlCellProjection = typeof SqlCellProjection.Type;

/**
 * Retained source projections for reversible cell-language changes.
 *
 * Both projections may coexist. The cell's current language selects which
 * projection is active; retaining the other restores its settings if the
 * user switches the cell back later.
 */
export const CellSourceProjections = Schema.Struct({
  markdown: Schema.NullOr(MarkdownCellProjection).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  sql: Schema.NullOr(SqlCellProjection).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "CellSourceProjections",
  parseOptions: { onExcessProperty: "error" },
});
export type CellSourceProjections = typeof CellSourceProjections.Type;

/**
 * Persisted marimo cell metadata used to serialize Python source.
 */
export const MarimoCellMetadata = Schema.Struct({
  name: Schema.String.pipe(Schema.withDecodingDefault(Effect.sync(() => "_"))),
  options: NotebookCellConfig.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  sourceProjections: CellSourceProjections.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
}).annotate({
  identifier: "MarimoCellMetadata",
  parseOptions: { onExcessProperty: "error" },
});
export type MarimoCellMetadata = typeof MarimoCellMetadata.Type;

/**
 * Transient per-open cell metadata shared with the LSP server.
 */
export const MarimoCellRuntimeMetadata = Schema.Struct({
  stableId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  state: Schema.NullOr(
    Schema.Literals(["idle", "queued", "running", "stale"]),
  ).pipe(Schema.withDecodingDefault(Effect.sync(() => null))),
}).annotate({
  identifier: "MarimoCellRuntimeMetadata",
  parseOptions: { onExcessProperty: "error" },
});
export type MarimoCellRuntimeMetadata = typeof MarimoCellRuntimeMetadata.Type;

/**
 * Namespaced metadata synchronized on an LSP notebook cell.
 */
export const CellMetadata = Schema.Struct({
  marimo: MarimoCellMetadata.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  marimoRuntime: MarimoCellRuntimeMetadata.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
}).annotate({
  identifier: "CellMetadata",
  parseOptions: { onExcessProperty: "preserve" },
});
export type CellMetadata = typeof CellMetadata.Type;

/**
 * Persisted marimo-owned metadata on an LSP notebook document.
 */
export const MarimoNotebookMetadata = Schema.Struct({
  appOptions: AppOptions.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  header: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  notebookMetadata: NotebookMetadata.pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
}).annotate({
  identifier: "MarimoNotebookMetadata",
  parseOptions: { onExcessProperty: "error" },
});
export type MarimoNotebookMetadata = typeof MarimoNotebookMetadata.Type;

/**
 * Canonical metadata envelope on an LSP notebook document.
 */
export const NotebookDocumentMetadata = Schema.Struct({
  marimo: MarimoNotebookMetadata,
}).annotate({
  identifier: "NotebookDocumentMetadata",
  parseOptions: { onExcessProperty: "preserve" },
});
export type NotebookDocumentMetadata = typeof NotebookDocumentMetadata.Type;

/**
 * A successfully parsed native marimo notebook.
 */
export const ParseNotebookSuccess = Schema.Struct({
  kind: Schema.Literal("success"),
  document: NotebookDocument,
}).annotate({
  identifier: "ParseNotebookSuccess",
  parseOptions: { onExcessProperty: "error" },
});
export type ParseNotebookSuccess = typeof ParseNotebookSuccess.Type;

/**
 * Python syntax prevented the source from being inspected.
 */
export const ParseNotebookInvalidSyntax = Schema.Struct({
  kind: Schema.Literal("invalid-syntax"),
  line: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  column: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({
  identifier: "ParseNotebookInvalidSyntax",
  parseOptions: { onExcessProperty: "error" },
});
export type ParseNotebookInvalidSyntax = typeof ParseNotebookInvalidSyntax.Type;

/**
 * Valid Python source that can be converted to a marimo notebook.
 */
export const ParseNotebookConvertible = Schema.Struct({
  kind: Schema.Literal("convertible"),
}).annotate({
  identifier: "ParseNotebookConvertible",
  parseOptions: { onExcessProperty: "error" },
});
export type ParseNotebookConvertible = typeof ParseNotebookConvertible.Type;

export const ParseNotebookResult = Schema.Union([
  ParseNotebookSuccess,
  ParseNotebookInvalidSyntax,
  ParseNotebookConvertible,
]).annotate({ identifier: "ParseNotebookResult" });
export type ParseNotebookResult = typeof ParseNotebookResult.Type;

/**
 * A request to convert a file source a marimo notebook.
 */
export const ConvertRequest = Schema.Struct({
  uri: Schema.String,
}).annotate({ identifier: "ConvertRequest" });
export type ConvertRequest = typeof ConvertRequest.Type;

/**
 * One cell projected from an authoritative live SessionView.
 */
export const LiveCellReplay = Schema.Struct({
  kind: Schema.Literal("live"),
  notification: CellOperationNotification,
  executedSource: Schema.NullOr(Schema.String),
}).annotate({ identifier: "LiveCellReplay" });
export type LiveCellReplay = typeof LiveCellReplay.Type;

/**
 * One cell restored from a compatible saved-session sidecar.
 */
export const SavedCellReplay = Schema.Struct({
  kind: Schema.Literal("saved"),
  notification: CellOperationNotification,
}).annotate({ identifier: "SavedCellReplay" });
export type SavedCellReplay = typeof SavedCellReplay.Type;

export const CellOutputReplay = Schema.Union([
  LiveCellReplay,
  SavedCellReplay,
]).annotate({ identifier: "CellOutputReplay" });
export type CellOutputReplay = typeof CellOutputReplay.Type;

/**
 * User-facing state for one live kernel session.
 */
export const SessionInfo = Schema.Struct({
  sessionId: KernelSessionIdFromString,
  notebookUri: NotebookIdFromString,
  filename: Schema.NullOr(Schema.String),
  executable: Schema.String,
  workingDirectory: Schema.String,
  startedAt: Schema.Number,
  status: Schema.Literals(["idle", "running"]),
  attached: Schema.Boolean,
}).annotate({ identifier: "SessionInfo" });
export type SessionInfo = typeof SessionInfo.Type;

/**
 * Snapshot of all live sessions owned by this language server.
 */
export const ListSessionsResponse = Schema.Struct({
  sessions: Schema.Array(SessionInfo),
}).annotate({ identifier: "ListSessionsResponse" });
export type ListSessionsResponse = typeof ListSessionsResponse.Type;

export const PackageDescription = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
}).annotate({ identifier: "PackageDescription" });
export type PackageDescription = typeof PackageDescription.Type;

/**
 * Response for ``list-packages``.
 */
export const ListPackagesResponse = Schema.Struct({
  packages: Schema.Array(PackageDescription),
}).annotate({ identifier: "ListPackagesResponse" });
export type ListPackagesResponse = typeof ListPackagesResponse.Type;

export const DependencyTag = Schema.Struct({
  kind: Schema.String,
  value: Schema.String,
}).annotate({ identifier: "DependencyTag" });
export type DependencyTag = typeof DependencyTag.Type;

export interface DependencyTreeNode {
  readonly name: string;
  readonly version: string | null;
  readonly tags: ReadonlyArray<DependencyTag>;
  readonly dependencies: ReadonlyArray<DependencyTreeNode>;
}
export const DependencyTreeNode = Schema.Struct({
  name: Schema.String,
  version: Schema.NullOr(Schema.String),
  tags: Schema.Array(DependencyTag),
  dependencies: Schema.Array(
    Schema.suspend((): Schema.Codec<DependencyTreeNode> => DependencyTreeNode),
  ),
}).annotate({ identifier: "DependencyTreeNode" });

/**
 * Response for ``get-dependency-tree``.
 */
export const DependencyTreeResponse = Schema.Struct({
  tree: Schema.NullOr(DependencyTreeNode).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "DependencyTreeResponse" });
export type DependencyTreeResponse = typeof DependencyTreeResponse.Type;

/**
 * Native marimo Python source printed from an owned notebook document.
 */
export const PrintNotebookResult = Schema.Struct({
  source: Schema.String,
}).annotate({
  identifier: "PrintNotebookResult",
  parseOptions: { onExcessProperty: "error" },
});
export type PrintNotebookResult = typeof PrintNotebookResult.Type;

/**
 * Configuration options for Anthropic.
 *
 * **Keys.**
 *
 * - `api_key`: the Anthropic API key
 */
export const AnthropicConfig = Schema.Struct({
  api_key: Schema.optional(Schema.String),
}).annotate({ identifier: "AnthropicConfig" });
export type AnthropicConfig = typeof AnthropicConfig.Type;

/**
 * Configuration options for OpenAI or OpenAI-compatible services.
 *
 * **Keys.**
 *
 * - `api_key`: the OpenAI API key
 * - `base_url`: the base URL for the API
 * - `project`: the project ID for the OpenAI API
 * - `ssl_verify` : Boolean argument for httpx passed to open ai client. httpx defaults to true, but some use cases to let users override to False in some testing scenarios
 * - `ca_bundle_path`: custom ca bundle to be used for verifying SSL certificates. Used to create custom SSL context for httpx client
 * - `client_pem` : custom path of a client .pem cert used for verifying identity of client server
 * - `extra_headers`: extra headers to be passed to the OpenAI client
 */
export const OpenAiConfig = Schema.Struct({
  api_key: Schema.optional(Schema.String),
  base_url: Schema.optional(Schema.String),
  ca_bundle_path: Schema.optional(Schema.String),
  client_pem: Schema.optional(Schema.String),
  extra_headers: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  model: Schema.optional(Schema.String),
  project: Schema.optional(Schema.String),
  ssl_verify: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "OpenAiConfig" });
export type OpenAiConfig = typeof OpenAiConfig.Type;

/**
 * Configuration options for Bedrock.
 *
 * **Keys.**
 *
 * - `profile_name`: the AWS profile to use
 * - `region_name`: the AWS region to use
 * - `aws_access_key_id`: the AWS access key ID
 * - `aws_secret_access_key`: the AWS secret access key
 */
export const BedrockConfig = Schema.Struct({
  aws_access_key_id: Schema.optional(Schema.String),
  aws_secret_access_key: Schema.optional(Schema.String),
  profile_name: Schema.optional(Schema.String),
  region_name: Schema.optional(Schema.String),
}).annotate({ identifier: "BedrockConfig" });
export type BedrockConfig = typeof BedrockConfig.Type;

/**
 * Configuration options for GitHub.
 *
 * **Keys.**
 *
 * - `api_key`: the GitHub API token
 * - `base_url`: the base URL for the API
 * - `copilot_settings`: configuration settings for GitHub Copilot LSP.
 *     Supports settings like `http` (proxy configuration), `telemetry`,
 *     and `github-enterprise` (enterprise URI).
 */
export const GitHubConfig = Schema.Struct({
  api_key: Schema.optional(Schema.String),
  base_url: Schema.optional(Schema.String),
  copilot_settings: Schema.optional(
    Schema.Record(Schema.String, Schema.Unknown),
  ),
}).annotate({ identifier: "GitHubConfig" });
export type GitHubConfig = typeof GitHubConfig.Type;

/**
 * Configuration options for Google AI.
 *
 * **Keys.**
 *
 * - `api_key`: the Google AI API key
 */
export const GoogleAiConfig = Schema.Struct({
  api_key: Schema.optional(Schema.String),
}).annotate({ identifier: "GoogleAiConfig" });
export type GoogleAiConfig = typeof GoogleAiConfig.Type;

/**
 * Configuration options for an AI model.
 *
 * **Keys.**
 *
 * - `chat_model`: the model to use for chat completions
 * - `edit_model`: the model to use for edit completions
 * - `autocomplete_model`: the model to use for code completion/autocomplete
 * - `displayed_models`: a list of models to display in the UI
 * - `custom_models`: a list of custom models to use that are not from the default list
 */
export const AiModelConfig = Schema.Struct({
  autocomplete_model: Schema.optional(Schema.String),
  chat_model: Schema.optional(Schema.String),
  custom_models: Schema.Array(Schema.String),
  displayed_models: Schema.Array(Schema.String),
  edit_model: Schema.optional(Schema.String),
}).annotate({ identifier: "AiModelConfig" });
export type AiModelConfig = typeof AiModelConfig.Type;

/**
 * Configuration options for AI.
 *
 * **Keys.**
 *
 * - `enabled`: if `False`, hide AI actions and panels in the marimo UI
 * - `rules`: custom rules to include in all AI completion prompts
 * - `max_tokens`: the maximum number of tokens to use in AI completions
 * - `mode`: the mode to use for AI completions. Can be one of: `"ask"` or `"manual"`
 * - `inline_tooltip`: if `True`, enable inline AI tooltip suggestions
 * - `models`: the models to use for AI completions
 * - `open_ai`: the OpenAI config
 * - `anthropic`: the Anthropic config
 * - `google`: the Google AI config
 * - `bedrock`: the Bedrock config
 * - `azure`: the Azure config
 * - `ollama`: the Ollama config
 * - `github`: the GitHub config
 * - `openrouter`: the OpenRouter config
 * - `wandb`: the Weights & Biases config
 * - `opencode_go`: the OpenCode Go config
 * - `custom_providers`: a dict of custom OpenAI-compatible providers
 * - `open_ai_compatible`: the OpenAI-compatible config (deprecated, use custom_providers)
 */
export const AiConfig = Schema.Struct({
  anthropic: Schema.optional(AnthropicConfig),
  azure: Schema.optional(OpenAiConfig),
  bedrock: Schema.optional(BedrockConfig),
  custom_providers: Schema.optional(Schema.Record(Schema.String, OpenAiConfig)),
  enabled: Schema.optional(Schema.Boolean),
  github: Schema.optional(GitHubConfig),
  google: Schema.optional(GoogleAiConfig),
  inline_tooltip: Schema.optional(Schema.Boolean),
  max_tokens: Schema.optional(Schema.Int),
  mode: Schema.optional(
    Schema.Literals(["agent", "ask", "code_mode", "manual"]),
  ),
  models: Schema.optional(AiModelConfig),
  ollama: Schema.optional(OpenAiConfig),
  open_ai: Schema.optional(OpenAiConfig),
  open_ai_compatible: Schema.optional(OpenAiConfig),
  opencode_go: Schema.optional(OpenAiConfig),
  openrouter: Schema.optional(OpenAiConfig),
  rules: Schema.optional(Schema.String),
  wandb: Schema.optional(OpenAiConfig),
}).annotate({ identifier: "AiConfig" });
export type AiConfig = typeof AiConfig.Type;

/**
 * Configuration for code completion.
 *
 * A dict with key/value pairs configuring code completion in the marimo
 * editor.
 *
 * **Keys.**
 *
 * - `activate_on_typing`: if `False`, completion won't activate
 * until the completion hotkey is entered
 * - `signature_hint_on_typing`: if `False`, signature hint won't be shown when typing
 * - `copilot`: one of `"github"`, `"codeium"`, or `"custom"`
 * - `codeium_api_key`: the Codeium API key
 * - `auto_close_pairs`: if `False`, typing an opening bracket, parenthesis,
 * or quote will not automatically insert the closing character
 */
export const CompletionConfig = Schema.Struct({
  activate_on_typing: Schema.Boolean,
  api_key: Schema.optional(Schema.NullOr(Schema.String)),
  auto_close_pairs: Schema.optional(Schema.Boolean),
  base_url: Schema.optional(Schema.NullOr(Schema.String)),
  codeium_api_key: Schema.optional(Schema.NullOr(Schema.String)),
  copilot: Schema.Union([
    Schema.Boolean,
    Schema.Literals(["codeium", "custom", "github"]),
  ]),
  model: Schema.optional(Schema.NullOr(Schema.String)),
  signature_hint_on_typing: Schema.Boolean,
}).annotate({ identifier: "CompletionConfig" });
export type CompletionConfig = typeof CompletionConfig.Type;

/**
 * Configuration for datasources panel.
 *
 * **Keys.**
 *
 * - `auto_discover_schemas`: if `True`, include schemas in the datasource
 * - `auto_discover_tables`: if `True`, include tables in the datasource
 * - `auto_discover_columns`: if `True`, include columns & table metadata in the datasource
 */
export const DatasourcesConfig = Schema.Struct({
  auto_discover_columns: Schema.optional(
    Schema.Union([Schema.Boolean, Schema.Literal("auto")]),
  ),
  auto_discover_schemas: Schema.optional(
    Schema.Union([Schema.Boolean, Schema.Literal("auto")]),
  ),
  auto_discover_tables: Schema.optional(
    Schema.Union([Schema.Boolean, Schema.Literal("auto")]),
  ),
}).annotate({ identifier: "DatasourcesConfig" });
export type DatasourcesConfig = typeof DatasourcesConfig.Type;

/**
 * Configuration options for diagnostics.
 *
 * **Keys.**
 *
 * - `enabled`: if `True`, diagnostics will be shown in the editor
 * - `sql_linter`: if `True`, SQL cells will have linting enabled
 */
export const DiagnosticsConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  sql_linter: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "DiagnosticsConfig" });
export type DiagnosticsConfig = typeof DiagnosticsConfig.Type;

/**
 * Configuration for display.
 *
 * **Keys.**
 *
 * - `theme`: `"light"`, `"dark"`, or `"system"`
 * - `code_editor_font_size`: font size for the code editor
 * - `cell_output`: `"above"` or `"below"`
 * - `dataframes`: `"rich"` or `"plain"`
 * - `custom_css`: list of paths to custom CSS files
 * - `default_table_page_size`: default number of rows to display in tables
 * - `default_table_max_columns`: default maximum number of columns to display in tables
 * - `reference_highlighting`: if `True`, highlight reactive variable references
 * - `code_lens`: if `True`, show inline icons in cell editors linking
 *   datasources, storage buckets, and caches to their panels
 * - `locale`: locale for date formatting and internationalization (e.g., "en-US", "en-GB", "de-DE")
 */
export const DisplayConfig = Schema.Struct({
  cell_output: Schema.Literals(["above", "below"]),
  code_editor_font_size: Schema.Int,
  code_lens: Schema.optional(Schema.Boolean),
  custom_css: Schema.optional(Schema.Array(Schema.String)),
  dataframes: Schema.Literals(["plain", "rich"]),
  default_table_max_columns: Schema.Int,
  default_table_page_size: Schema.Int,
  default_width: Schema.Literals([
    "columns",
    "compact",
    "full",
    "medium",
    "normal",
  ]),
  locale: Schema.optional(Schema.NullOr(Schema.String)),
  reference_highlighting: Schema.optional(Schema.Boolean),
  theme: Schema.Literals(["dark", "light", "system"]),
}).annotate({ identifier: "DisplayConfig" });
export type DisplayConfig = typeof DisplayConfig.Type;

/**
 * Configuration for code formatting.
 *
 * **Keys.**
 *
 * - `line_length`: max line length
 */
export const FormattingConfig = Schema.Struct({
  line_length: Schema.Int,
}).annotate({ identifier: "FormattingConfig" });
export type FormattingConfig = typeof FormattingConfig.Type;

/**
 * Configuration for keymaps.
 *
 * **Keys.**
 *
 * - `preset`: one of `"default"` or `"vim"`
 * - `overrides`: a dict of keymap actions to their keymap override
 * - `vimrc`: path to a vimrc file to load keymaps from
 * - `destructive_delete`: if `True`, allows deleting cells with content.
 */
export const KeymapConfig = Schema.Struct({
  destructive_delete: Schema.optional(Schema.Boolean),
  overrides: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  preset: Schema.Literals(["default", "vim"]),
  vimrc: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "KeymapConfig" });
export type KeymapConfig = typeof KeymapConfig.Type;

/**
 * Configuration options for basedpyright Language Server.
 *
 * basedpyright handles completion, hover, go-to-definition, and diagnostics,
 * but we only use it for diagnostics.
 */
export const BasedpyrightServerConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "BasedpyrightServerConfig" });
export type BasedpyrightServerConfig = typeof BasedpyrightServerConfig.Type;

/**
 * Configuration options for Python Language Server.
 *
 * pylsp handles completion, hover, go-to-definition, and diagnostics.
 */
export const PythonLanguageServerConfig = Schema.Struct({
  enable_flake8: Schema.optional(Schema.Boolean),
  enable_mypy: Schema.optional(Schema.Boolean),
  enable_pydocstyle: Schema.optional(Schema.Boolean),
  enable_pyflakes: Schema.optional(Schema.Boolean),
  enable_pylint: Schema.optional(Schema.Boolean),
  enable_ruff: Schema.optional(Schema.Boolean),
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "PythonLanguageServerConfig" });
export type PythonLanguageServerConfig = typeof PythonLanguageServerConfig.Type;

/**
 * Configuration options for Pyrefly Language Server.
 *
 * Pyrefly handles completion, hover, go-to-definition, and diagnostics.
 */
export const PyreflyLanguageServerConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "PyreflyLanguageServerConfig" });
export type PyreflyLanguageServerConfig =
  typeof PyreflyLanguageServerConfig.Type;

/**
 * Configuration options for Ty Language Server.
 *
 * ty handles completion, hover, go-to-definition, and diagnostics,
 * but we only use it for diagnostics.
 */
export const TyLanguageServerConfig = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "TyLanguageServerConfig" });
export type TyLanguageServerConfig = typeof TyLanguageServerConfig.Type;

/**
 * Configuration options for language servers.
 *
 * **Keys.**
 *
 * - `pylsp`: the pylsp config
 * - `basedpyright`: the basedpyright config
 * - `ty`: the ty config
 * - `pyrefly`: the pyrefly config
 */
export const LanguageServersConfig = Schema.Struct({
  basedpyright: Schema.optional(BasedpyrightServerConfig),
  pylsp: Schema.optional(PythonLanguageServerConfig),
  pyrefly: Schema.optional(PyreflyLanguageServerConfig),
  ty: Schema.optional(TyLanguageServerConfig),
}).annotate({ identifier: "LanguageServersConfig" });
export type LanguageServersConfig = typeof LanguageServersConfig.Type;

/**
 * Configuration for lint rule selection.
 *
 * Follows ruff-inspired semantics for selecting which rules to run
 * during `marimo check`.
 *
 * **Keys.**
 *
 * - `select`: list of rule code prefixes that replaces the default
 *   enabled set. Use `"ALL"` to select all rules.
 *   Example: `["MB", "MR001"]`
 * - `ignore`: list of rule code prefixes to remove from the
 *   enabled set.
 */
export const LintConfig = Schema.Struct({
  ignore: Schema.optional(Schema.Array(Schema.String)),
  select: Schema.optional(Schema.Array(Schema.String)),
}).annotate({ identifier: "LintConfig" });
export type LintConfig = typeof LintConfig.Type;

/**
 * Configuration for MCP servers
 *
 * Note: the field name `mcpServers` is camelCased to match MCP server
 * config conventions used by popular AI applications (e.g. Cursor, Claude Desktop, etc.)
 */
export const MCPConfig = Schema.Struct({
  mcpServers: Schema.Record(
    Schema.String,
    Schema.Record(Schema.String, Schema.Unknown),
  ),
  presets: Schema.optional(
    Schema.Array(Schema.Literals(["context7", "marimo"])),
  ),
}).annotate({ identifier: "MCPConfig" });
export type MCPConfig = typeof MCPConfig.Type;

/**
 * Configuration options for package management.
 *
 * **Keys.**
 *
 * - `manager`: the package manager to use
 */
export const PackageManagementConfig = Schema.Struct({
  manager: Schema.Literals(["pip", "pixi", "poetry", "rye", "uv"]),
}).annotate({ identifier: "PackageManagementConfig" });
export type PackageManagementConfig = typeof PackageManagementConfig.Type;

/**
 * Configuration for runtime.
 *
 * **Keys.**
 *
 * - `auto_instantiate`: if `False`, cells won't automatically
 *     run on startup. This only applies when editing a notebook,
 *     and not when running as an application.
 *     The default is `True`.
 * - `auto_reload`: if `lazy`, cells importing modified modules will marked
 *   as stale; if `autorun`, affected cells will be automatically run. similar
 *   to IPython's %autoreload extension but with more code intelligence.
 * - `reactive_tests`: if `True`, marimo will automatically run pytest on cells containing only test functions and test classes.
 *   execution.
 * - `on_cell_change`: if `lazy`, cells will be marked stale when their
 *   ancestors run but won't autorun; if `autorun`, cells will automatically
 *   run when their ancestors run.
 * - `execution_type`: if `relaxed`, marimo will not clone cell declarations;
 *   if `strict` marimo will clone cell declarations by default, avoiding
 *   hidden potential state build up.
 * - `watcher_on_save`: how to handle file changes when saving. `"lazy"` marks
 *     affected cells as stale, `"autorun"` automatically runs affected cells.
 * - `output_max_bytes`: the maximum size in bytes of cell outputs; larger
 *     values may affect frontend performance
 * - `serve_cached_sessions_in_apps`: if `True`, initialize applications with session cache.
 *     The default is `False`.
 * - `std_stream_max_bytes`: the maximum size in bytes of console outputs;
 *   larger values may affect frontend performance
 * - `pythonpath`: a list of directories to add to the Python search path.
 *     Directories will be added to the head of sys.path. Similar to the
 *     `PYTHONPATH` environment variable, the directories will be included in
 *     where Python will look for imported modules.
 * - `dotenv`: a list of paths to `.env` files to load.
 *     If the file does not exist, it will be silently ignored.
 *     The default is `[".env"]` if a pyproject.toml is found, otherwise `[]`.
 * - `default_sql_output`: the default output format for SQL queries. Can be one of:
 *     `"auto"`, `"native"`, `"polars"`, `"lazy-polars"`, or `"pandas"`.
 *     The default is `"auto"`.
 * - `default_auto_download`: an Optional list of export types to automatically snapshot your notebook as:
 *    `html`, `markdown`, `ipynb`.
 *    The default is None.
 * - `default_csv_encoding`: the default encoding for CSV exports.
 *     The default is `"utf-8"`.
 * - `show_tracebacks`: if `True`, show detailed error tracebacks in run mode.
 *     When enabled, exceptions will display a clickable toast that opens a modal with the full traceback.
 *     The default is `False`.
 */
export const RuntimeConfig = Schema.Struct({
  auto_instantiate: Schema.Boolean,
  auto_reload: Schema.Literals(["autorun", "lazy", "off"]),
  default_auto_download: Schema.optional(
    Schema.Array(Schema.Literals(["html", "ipynb", "markdown"])),
  ),
  default_csv_encoding: Schema.optional(Schema.String),
  default_sql_output: Schema.Literals([
    "auto",
    "lazy-polars",
    "native",
    "pandas",
    "polars",
  ]),
  dotenv: Schema.optional(Schema.Array(Schema.String)),
  on_cell_change: Schema.Literals(["autorun", "lazy"]),
  output_max_bytes: Schema.Int,
  pythonpath: Schema.optional(Schema.Array(Schema.String)),
  reactive_tests: Schema.Boolean,
  serve_cached_sessions_in_apps: Schema.optional(Schema.Boolean),
  show_tracebacks: Schema.optional(Schema.Boolean),
  std_stream_max_bytes: Schema.Int,
  watcher_on_save: Schema.Literals(["autorun", "lazy"]),
}).annotate({ identifier: "RuntimeConfig" });
export type RuntimeConfig = typeof RuntimeConfig.Type;

/**
 * Configuration for saving.
 *
 * **Keys.**
 *
 * - `autosave`: one of `"off"` or `"after_delay"`
 * - `delay`: number of milliseconds to wait before autosaving
 * - `format_on_save`: if `True`, format the code on save
 */
export const SaveConfig = Schema.Struct({
  autosave: Schema.Literals(["after_delay", "off"]),
  autosave_delay: Schema.Int,
  format_on_save: Schema.Boolean,
}).annotate({ identifier: "SaveConfig" });
export type SaveConfig = typeof SaveConfig.Type;

/**
 * Configuration for the server.
 *
 * **Keys.**
 *
 * - `browser`: the web browser to use. `"default"` or a browser registered
 *     with Python's webbrowser module (eg, `"firefox"` or `"chrome"`)
 * - `follow_symlink`: if true, the server will follow symlinks it finds
 *     inside its static assets directory.
 * - `disable_file_downloads`: if true, the file download button will be
 *     hidden in the file explorer.
 * - `transport`: experimental. The transport used to stream kernel
 *     messages to the frontend, typically set with the
 *     `MARIMO_SERVER_TRANSPORT` environment variable. `"websocket"`
 *     (default) uses the `/ws` WebSocket endpoint; `"sse"` uses
 *     server-sent events over HTTP, for deployments behind proxies or
 *     services that do not support WebSockets. Terminal, LSP, and
 *     real-time collaboration still require WebSockets; RTC is disabled
 *     when using `"sse"`.
 */
export const ServerConfig = Schema.Struct({
  browser: Schema.Union([Schema.Literal("default"), Schema.String]),
  disable_file_downloads: Schema.optional(Schema.Boolean),
  follow_symlink: Schema.Boolean,
  transport: Schema.optional(Schema.Literals(["sse", "websocket"])),
}).annotate({ identifier: "ServerConfig" });
export type ServerConfig = typeof ServerConfig.Type;

/**
 * Configuration for sharing features.
 *
 * **Keys.**
 *
 * - `html`: if `False`, HTML sharing options will be hidden from the UI
 * - `wasm`: if `False`, WebAssembly sharing options will be hidden from the UI
 * - `molab`: if `False`, molab sharing options will be hidden from the UI
 */
export const SharingConfig = Schema.Struct({
  html: Schema.optional(Schema.Boolean),
  molab: Schema.optional(Schema.Boolean),
  wasm: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SharingConfig" });
export type SharingConfig = typeof SharingConfig.Type;

/**
 * Configuration for snippets.
 *
 * **Keys.**
 *
 * - `custom_path`: the path to the custom snippets directory
 */
export const SnippetsConfig = Schema.Struct({
  custom_paths: Schema.optional(Schema.Array(Schema.String)),
  include_default_snippets: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "SnippetsConfig" });
export type SnippetsConfig = typeof SnippetsConfig.Type;

/**
 * Configuration for external Python environment in home sandbox mode.
 *
 * Allows specifying an existing virtualenv to use instead of creating
 * ephemeral sandboxes per notebook. Only applies in home sandbox mode.
 *
 * **Keys.**
 *
 * - `path`: path to a virtualenv directory (absolute or relative to
 *   pyproject.toml)
 * - `writable`: if true, marimo will manage script metadata (inline
 *   dependencies). Defaults to false.
 */
export const VenvConfig = Schema.Struct({
  path: Schema.optional(Schema.String),
  writable: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "VenvConfig" });
export type VenvConfig = typeof VenvConfig.Type;

/**
 * Configuration for the marimo editor
 */
export const MarimoConfig = Schema.Struct({
  ai: Schema.optional(AiConfig),
  completion: CompletionConfig,
  datasources: Schema.optional(DatasourcesConfig),
  diagnostics: Schema.optional(DiagnosticsConfig),
  display: DisplayConfig,
  experimental: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  formatting: FormattingConfig,
  keymap: KeymapConfig,
  language_servers: Schema.optional(LanguageServersConfig),
  lint: Schema.optional(LintConfig),
  mcp: Schema.optional(MCPConfig),
  package_management: PackageManagementConfig,
  runtime: RuntimeConfig,
  save: SaveConfig,
  server: ServerConfig,
  sharing: Schema.optional(SharingConfig),
  snippets: Schema.optional(SnippetsConfig),
  venv: Schema.optional(VenvConfig),
}).annotate({ identifier: "MarimoConfig" });
export type MarimoConfig = typeof MarimoConfig.Type;

/**
 * Response for ``get-configuration``.
 */
export const GetConfigurationResponse = Schema.Struct({
  config: MarimoConfig,
}).annotate({ identifier: "GetConfigurationResponse" });
export type GetConfigurationResponse = typeof GetConfigurationResponse.Type;

/**
 * Response for ``set-display-theme``.
 */
export const SetDisplayThemeResponse = Schema.Struct({
  success: Schema.Boolean,
}).annotate({ identifier: "SetDisplayThemeResponse" });
export type SetDisplayThemeResponse = typeof SetDisplayThemeResponse.Type;

/**
 * Cell outputs replayed from live memory or a saved-session sidecar.
 */
export const ReadNotebookOutputsResponse = Schema.Struct({
  cells: Schema.Array(CellOutputReplay),
}).annotate({ identifier: "ReadNotebookOutputsResponse" });
export type ReadNotebookOutputsResponse =
  typeof ReadNotebookOutputsResponse.Type;

type CommandTransport<E, R> = (
  command: typeof Command.Encoded,
) => Effect.Effect<unknown, E, R>;

/**
 * Validate the complete outgoing command, send it verbatim, and parse the
 * response against the command's declared success schema.
 */
const dispatch = <Success extends Schema.Top, E, R>(
  send: CommandTransport<E, R>,
  command: typeof Command.Encoded,
  success: Success,
): Effect.Effect<
  Success["Type"],
  E | Schema.SchemaError,
  R | Success["DecodingServices"]
> =>
  Effect.flatMap(Schema.decodeEffect(Command)(command), () =>
    Effect.flatMap(send(command), Schema.decodeUnknownEffect(success)),
  );

/**
 * Named extension methods over the private owned command protocol.
 *
 * Ordinary extension code never constructs or switches over the raw union.
 */
export const makeCommandClient = <E, R>(send: CommandTransport<E, R>) => ({
  execute: (params: Omit<typeof Execute.Encoded, "kind">) => {
    const command = {
      kind: "execute",
      ...params,
    } satisfies typeof Execute.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  updateUiElement: (params: Omit<typeof UpdateUiElement.Encoded, "kind">) => {
    const command = {
      kind: "update-ui-element",
      ...params,
    } satisfies typeof UpdateUiElement.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  setModelValue: (params: Omit<typeof SetModelValue.Encoded, "kind">) => {
    const command = {
      kind: "set-model-value",
      ...params,
    } satisfies typeof SetModelValue.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  invokeFunction: (params: Omit<typeof InvokeFunction.Encoded, "kind">) => {
    const command = {
      kind: "invoke-function",
      ...params,
    } satisfies typeof InvokeFunction.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  interrupt: (params: Omit<typeof Interrupt.Encoded, "kind">) => {
    const command = {
      kind: "interrupt",
      ...params,
    } satisfies typeof Interrupt.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  deleteCell: (params: Omit<typeof DeleteCell.Encoded, "kind">) => {
    const command = {
      kind: "delete-cell",
      ...params,
    } satisfies typeof DeleteCell.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  listSqlSchemas: (params: Omit<typeof ListSqlSchemas.Encoded, "kind">) => {
    const command = {
      kind: "list-sql-schemas",
      ...params,
    } satisfies typeof ListSqlSchemas.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  listSqlTables: (params: Omit<typeof ListSqlTables.Encoded, "kind">) => {
    const command = {
      kind: "list-sql-tables",
      ...params,
    } satisfies typeof ListSqlTables.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  sendStdin: (params: Omit<typeof SendStdin.Encoded, "kind">) => {
    const command = {
      kind: "send-stdin",
      ...params,
    } satisfies typeof SendStdin.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  closeSession: (params: Omit<typeof CloseSession.Encoded, "kind">) => {
    const command = {
      kind: "close-session",
      ...params,
    } satisfies typeof CloseSession.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  restartSession: (params: Omit<typeof RestartSession.Encoded, "kind">) => {
    const command = {
      kind: "restart-session",
      ...params,
    } satisfies typeof RestartSession.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  moveSession: (params: Omit<typeof MoveSession.Encoded, "kind">) => {
    const command = {
      kind: "move-session",
      ...params,
    } satisfies typeof MoveSession.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  listSessions: (params: Omit<typeof ListSessions.Encoded, "kind">) => {
    const command = {
      kind: "list-sessions",
      ...params,
    } satisfies typeof ListSessions.Encoded;
    return dispatch(send, command, ListSessionsResponse);
  },
  shutdownAllSessions: (
    params: Omit<typeof ShutdownAllSessions.Encoded, "kind">,
  ) => {
    const command = {
      kind: "shutdown-all-sessions",
      ...params,
    } satisfies typeof ShutdownAllSessions.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  executeScratchpad: (
    params: Omit<typeof ExecuteScratchpad.Encoded, "kind">,
  ) => {
    const command = {
      kind: "execute-scratchpad",
      ...params,
    } satisfies typeof ExecuteScratchpad.Encoded;
    return dispatch(send, command, Schema.Null);
  },
  listPackages: (params: Omit<typeof ListPackages.Encoded, "kind">) => {
    const command = {
      kind: "list-packages",
      ...params,
    } satisfies typeof ListPackages.Encoded;
    return dispatch(send, command, ListPackagesResponse);
  },
  getDependencyTree: (
    params: Omit<typeof GetDependencyTree.Encoded, "kind">,
  ) => {
    const command = {
      kind: "get-dependency-tree",
      ...params,
    } satisfies typeof GetDependencyTree.Encoded;
    return dispatch(send, command, DependencyTreeResponse);
  },
  printNotebook: (params: Omit<typeof PrintNotebook.Encoded, "kind">) => {
    const command = {
      kind: "print-notebook",
      ...params,
    } satisfies typeof PrintNotebook.Encoded;
    return dispatch(send, command, PrintNotebookResult);
  },
  parseNotebook: (params: Omit<typeof ParseNotebook.Encoded, "kind">) => {
    const command = {
      kind: "parse-notebook",
      ...params,
    } satisfies typeof ParseNotebook.Encoded;
    return dispatch(send, command, ParseNotebookResult);
  },
  getConfiguration: (params: Omit<typeof GetConfiguration.Encoded, "kind">) => {
    const command = {
      kind: "get-configuration",
      ...params,
    } satisfies typeof GetConfiguration.Encoded;
    return dispatch(send, command, GetConfigurationResponse);
  },
  updateConfiguration: (
    params: Omit<typeof UpdateConfiguration.Encoded, "kind">,
  ) => {
    const command = {
      kind: "update-configuration",
      ...params,
    } satisfies typeof UpdateConfiguration.Encoded;
    return dispatch(send, command, MarimoConfig);
  },
  setDisplayTheme: (params: Omit<typeof SetDisplayTheme.Encoded, "kind">) => {
    const command = {
      kind: "set-display-theme",
      ...params,
    } satisfies typeof SetDisplayTheme.Encoded;
    return dispatch(send, command, SetDisplayThemeResponse);
  },
  readNotebookOutputs: (
    params: Omit<typeof ReadNotebookOutputs.Encoded, "kind">,
  ) => {
    const command = {
      kind: "read-notebook-outputs",
      ...params,
    } satisfies typeof ReadNotebookOutputs.Encoded;
    return dispatch(send, command, ReadNotebookOutputsResponse);
  },
  exportHtml: (params: Omit<typeof ExportHtml.Encoded, "kind">) => {
    const command = {
      kind: "export-html",
      ...params,
    } satisfies typeof ExportHtml.Encoded;
    return dispatch(send, command, Schema.String);
  },
  exportIpynb: (params: Omit<typeof ExportIpynb.Encoded, "kind">) => {
    const command = {
      kind: "export-ipynb",
      ...params,
    } satisfies typeof ExportIpynb.Encoded;
    return dispatch(send, command, Schema.String);
  },
  exportMarkdown: (params: Omit<typeof ExportMarkdown.Encoded, "kind">) => {
    const command = {
      kind: "export-markdown",
      ...params,
    } satisfies typeof ExportMarkdown.Encoded;
    return dispatch(send, command, Schema.String);
  },
});
