// AUTO-GENERATED FILE — DO NOT EDIT.
//
// Generated from `src/marimo_lsp/models.py` and the `marimo.api` registry
// (`API_METHODS` in `src/marimo_lsp/api.py`) by `scripts.codegen`.
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

type VariablesNotification = Extract<MarimoNotification, { op: "variables" }>;
const VariablesNotification = Schema.declare<VariablesNotification>(
  (value): value is VariablesNotification =>
    Schema.is(MarimoNotification)(value) && value.op === "variables",
);

type CellOperationNotification = Extract<MarimoNotification, { op: "cell-op" }>;
type MarimoCellOutput = NonNullable<CellOperationNotification["output"]>;
const MarimoCellOutput = Schema.declare<MarimoCellOutput>(
  (value): value is MarimoCellOutput =>
    typeof value === "object" &&
    value !== null &&
    "channel" in value &&
    typeof value.channel === "string" &&
    "mimetype" in value &&
    typeof value.mimetype === "string" &&
    "data" in value,
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

/**
 * The notebook's environment is a concrete venv with a known python executable.
 */
export const VenvSource = Schema.Struct({
  kind: Schema.Literal("venv"),
  executable: Schema.String,
}).annotate({ identifier: "VenvSource" });
export type VenvSource = typeof VenvSource.Type;

/**
 * The notebook's environment is a PEP 723 sandbox script.
 *
 * The server resolves the script filename from the notebook URI; `uv`
 * derives the venv from the script's inline metadata.
 */
export const ScriptSource = Schema.Struct({
  kind: Schema.Literal("script"),
}).annotate({ identifier: "ScriptSource" });
export type ScriptSource = typeof ScriptSource.Type;

export const PackageSource = Schema.Union([VenvSource, ScriptSource]).annotate({
  identifier: "PackageSource",
});
export type PackageSource = typeof PackageSource.Type;

/**
 * App options understood by the extension, projected from ``AppConfig``.
 *
 * Codegen preserves excess properties in TypeScript so parsing this owned
 * subset never discards options belonging to marimo or a future extension.
 */
export const OwnedAppConfig = Schema.Struct({
  auto_download: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
}).annotate({
  identifier: "OwnedAppConfig",
  parseOptions: { onExcessProperty: "preserve" },
});
export type OwnedAppConfig = typeof OwnedAppConfig.Type;

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
 * Configuration for a notebook cell
 */
export const NotebookCellConfig = Schema.Struct({
  column: Schema.optional(Schema.NullOr(Schema.Int)),
  disabled: Schema.optional(Schema.NullOr(Schema.Boolean)),
  hide_code: Schema.optional(Schema.NullOr(Schema.Boolean)),
}).annotate({ identifier: "NotebookCellConfig" });
export type NotebookCellConfig = typeof NotebookCellConfig.Type;

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
 * Metadata about the notebook
 */
export const NotebookMetadata = Schema.Struct({
  marimo_version: Schema.optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "NotebookMetadata" });
export type NotebookMetadata = typeof NotebookMetadata.Type;

/**
 * Persisted marimo-owned metadata on an LSP notebook document.
 */
export const MarimoNotebookMetadata = Schema.Struct({
  appConfig: Schema.Record(Schema.String, Schema.Unknown).pipe(
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
 * Code cell specific structure
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
 * Main notebook structure
 */
export const NotebookV1 = Schema.Struct({
  cells: Schema.Array(NotebookCell),
  metadata: NotebookMetadata,
  version: Schema.Literal("1"),
}).annotate({ identifier: "NotebookV1" });
export type NotebookV1 = typeof NotebookV1.Type;

/**
 * Strict JSON notebook data plus source-level application metadata.
 */
export const NotebookDocument = Schema.Struct({
  notebook: NotebookV1,
  appConfig: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  header: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "NotebookDocument" });
export type NotebookDocument = typeof NotebookDocument.Type;

/**
 * A request to deserialize Python source to notebook format.
 *
 * Contains the source code to be parsed.
 */
export const DeserializeRequest = Schema.Struct({
  source: Schema.String,
}).annotate({ identifier: "DeserializeRequest" });
export type DeserializeRequest = typeof DeserializeRequest.Type;

/**
 * A successfully parsed native marimo notebook.
 */
export const DeserializeSuccess = Schema.Struct({
  kind: Schema.Literal("success"),
  notebook: NotebookDocument,
}).annotate({ identifier: "DeserializeSuccess" });
export type DeserializeSuccess = typeof DeserializeSuccess.Type;

/**
 * Python syntax prevented the source from being inspected.
 */
export const DeserializeInvalidSyntax = Schema.Struct({
  kind: Schema.Literal("invalid-syntax"),
  line: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  column: Schema.NullOr(Schema.Int).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "DeserializeInvalidSyntax" });
export type DeserializeInvalidSyntax = typeof DeserializeInvalidSyntax.Type;

/**
 * Valid Python source that can be converted to a marimo notebook.
 */
export const DeserializeConvertible = Schema.Struct({
  kind: Schema.Literal("convertible"),
}).annotate({ identifier: "DeserializeConvertible" });
export type DeserializeConvertible = typeof DeserializeConvertible.Type;

export const DeserializeResult = Schema.Union([
  DeserializeSuccess,
  DeserializeInvalidSyntax,
  DeserializeConvertible,
]).annotate({ identifier: "DeserializeResult" });
export type DeserializeResult = typeof DeserializeResult.Type;

/**
 * A request to convert a file source a marimo notebook.
 */
export const ConvertRequest = Schema.Struct({
  uri: Schema.String,
}).annotate({ identifier: "ConvertRequest" });
export type ConvertRequest = typeof ConvertRequest.Type;

/**
 * A request to interrupt the kernel execution.
 */
export const InterruptRequest = Schema.Struct({
  runId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  sessionId: Schema.NullOr(KernelSessionIdFromString).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "InterruptRequest" });
export type InterruptRequest = typeof InterruptRequest.Type;

/**
 * A request to list installed packages in the kernel environment.
 */
export const ListPackagesRequest = Schema.Struct({}).annotate({
  identifier: "ListPackagesRequest",
});
export type ListPackagesRequest = typeof ListPackagesRequest.Type;

/**
 * A request to get the dependency tree of installed packages.
 */
export const DependencyTreeRequest = Schema.Struct({}).annotate({
  identifier: "DependencyTreeRequest",
});
export type DependencyTreeRequest = typeof DependencyTreeRequest.Type;

/**
 * A request to get the current configuration.
 */
export const GetConfigurationRequest = Schema.Struct({}).annotate({
  identifier: "GetConfigurationRequest",
});
export type GetConfigurationRequest = typeof GetConfigurationRequest.Type;

/**
 * A request to close the current session.
 */
export const CloseSessionRequest = Schema.Struct({}).annotate({
  identifier: "CloseSessionRequest",
});
export type CloseSessionRequest = typeof CloseSessionRequest.Type;

/**
 * A request to export the notebook as ipynb.
 */
export const ExportAsIpynbRequest = Schema.Struct({}).annotate({
  identifier: "ExportAsIpynbRequest",
});
export type ExportAsIpynbRequest = typeof ExportAsIpynbRequest.Type;

/**
 * Execute arbitrary Python code outside the dependency graph.
 */
export const ExecuteScratchRequest = Schema.Struct({
  code: Schema.String,
  runId: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "ExecuteScratchRequest" });
export type ExecuteScratchRequest = typeof ExecuteScratchRequest.Type;

/**
 * A request to update the user configuration.
 */
export const UpdateConfigurationRequest = Schema.Struct({
  config: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "UpdateConfigurationRequest" });
export type UpdateConfigurationRequest = typeof UpdateConfigurationRequest.Type;

/**
 * A request to set the display theme without persisting to disk.
 */
export const SetDisplayThemeRequest = Schema.Struct({
  theme: Schema.Literals(["dark", "light"]),
}).annotate({ identifier: "SetDisplayThemeRequest" });
export type SetDisplayThemeRequest = typeof SetDisplayThemeRequest.Type;

/**
 * Saved-session contents read by the extension from the kernel environment.
 */
export const DecodeSavedSessionRequest = Schema.Struct({
  contents: Schema.String,
  marimoVersion: Schema.String,
  notebookVersion: Schema.Int,
}).annotate({ identifier: "DecodeSavedSessionRequest" });
export type DecodeSavedSessionRequest = typeof DecodeSavedSessionRequest.Type;

/**
 * Archived display data for one current notebook cell.
 */
export const SavedCellOutput = Schema.Struct({
  cellId: Schema.String,
  output: Schema.NullOr(MarimoCellOutput),
  console: Schema.Array(MarimoCellOutput),
}).annotate({ identifier: "SavedCellOutput" });
export type SavedCellOutput = typeof SavedCellOutput.Type;

/**
 * Compatible display outputs and the snapshot provenance they require.
 */
export const DecodeSavedSessionResponse = Schema.Struct({
  outputs: Schema.Array(SavedCellOutput),
  marimoVersion: Schema.String,
  notebookVersion: Schema.Int,
}).annotate({ identifier: "DecodeSavedSessionResponse" });
export type DecodeSavedSessionResponse = typeof DecodeSavedSessionResponse.Type;

/**
 * Serializable HTTP request representation.
 *
 * Mimics Starlette/FastAPI Request but is pickle-able and contains only a safe
 * subset of data. Excludes session and auth to prevent exposing sensitive data.
 *
 * Attributes:
 *     url: Serialized URL with path, port, scheme, netloc, query, hostname.
 *     base_url: Serialized base URL.
 *     headers: Request headers (marimo-specific headers excluded).
 *     query_params: Query parameters mapped to lists of values.
 *     path_params: Path parameters from the URL route.
 *     cookies: Request cookies.
 *     meta: User-defined storage for custom data.
 *     user: User info from authentication middleware (e.g., is_authenticated, username).
 */
export const HTTPRequest = Schema.Struct({
  url: Schema.Record(Schema.String, Schema.Unknown),
  base_url: Schema.Record(Schema.String, Schema.Unknown),
  headers: Schema.Record(Schema.String, Schema.String),
  query_params: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  path_params: Schema.Record(Schema.String, Schema.Unknown),
  cookies: Schema.Record(Schema.String, Schema.String),
  meta: Schema.Record(Schema.String, Schema.Unknown),
  user: Schema.Unknown,
}).annotate({ identifier: "HTTPRequest" });
export type HTTPRequest = typeof HTTPRequest.Type;

export const ExecuteCellsRequest = Schema.Struct({
  cellIds: Schema.Array(Schema.String),
  codes: Schema.Array(Schema.String),
  request: Schema.NullOr(HTTPRequest).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "ExecuteCellsRequest" });
export type ExecuteCellsRequest = typeof ExecuteCellsRequest.Type;

export const ExecuteCellsPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ExecuteCellsRequest,
  executable: Schema.String,
  workingDirectory: Schema.String,
  marimoVersion: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
});

export const UpdateUIElementRequest = Schema.Struct({
  objectIds: Schema.Array(Schema.String),
  values: Schema.Array(Schema.Unknown),
  request: Schema.NullOr(HTTPRequest).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
  token: Schema.optional(Schema.String),
}).annotate({ identifier: "UpdateUIElementRequest" });
export type UpdateUIElementRequest = typeof UpdateUIElementRequest.Type;

export const UpdateUiElementPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: UpdateUIElementRequest,
  sessionId: KernelSessionIdFromString,
});

/**
 * Widget model state update message.
 *
 * Attributes:
 *     state: Model state updates.
 *     buffer_paths: Paths within state dict pointing to binary buffers.
 */
export const ModelUpdateMessage = Schema.Struct({
  method: Schema.Literal("update"),
  state: Schema.Record(Schema.String, Schema.Unknown),
  bufferPaths: Schema.Array(
    Schema.Array(Schema.Union([Schema.String, Schema.Int])),
  ),
}).annotate({ identifier: "ModelUpdateMessage" });
export type ModelUpdateMessage = typeof ModelUpdateMessage.Type;

/**
 * Custom widget message.
 *
 * Attributes:
 *     content: Arbitrary content for the custom message.
 */
export const ModelCustomMessage = Schema.Struct({
  method: Schema.Literal("custom"),
  content: Schema.Unknown,
}).annotate({ identifier: "ModelCustomMessage" });
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

export const ModelRequest = Schema.Struct({
  modelId: Schema.String,
  message: Schema.Union([ModelUpdateMessage, ModelCustomMessage]),
  buffers: Schema.Array(Base64String),
  token: Schema.optional(Schema.String),
}).annotate({ identifier: "ModelRequest" });
export type ModelRequest = typeof ModelRequest.Type;

export const SetModelValuePayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ModelRequest,
  sessionId: KernelSessionIdFromString,
});

/**
 * Invoke a function from a UI element.
 *
 * Called when a UI element needs to invoke a Python function.
 *
 * Attributes:
 *     function_call_id: Unique identifier for this call.
 *     namespace: Namespace where the function is registered.
 *     function_name: Function to invoke.
 *     args: Keyword arguments for the function.
 */
export const InvokeFunctionCommand = Schema.Struct({
  type: Schema.Literal("invoke-function"),
  functionCallId: Schema.String,
  namespace: Schema.String,
  functionName: Schema.String,
  args: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "InvokeFunctionCommand" });
export type InvokeFunctionCommand = typeof InvokeFunctionCommand.Type;

export const InvokeFunctionPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: InvokeFunctionCommand,
  sessionId: KernelSessionIdFromString,
});

export const InterruptPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: InterruptRequest,
});

export const DeleteCellRequest = Schema.Struct({
  cellId: Schema.String,
}).annotate({ identifier: "DeleteCellRequest" });
export type DeleteCellRequest = typeof DeleteCellRequest.Type;

export const DeleteCellPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: DeleteCellRequest,
  sessionId: KernelSessionIdFromString,
});

export const ListSQLSchemasRequest = Schema.Struct({
  requestId: Schema.String,
  engine: Schema.String,
  database: Schema.String,
  schemaPath: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
}).annotate({ identifier: "ListSQLSchemasRequest" });
export type ListSQLSchemasRequest = typeof ListSQLSchemasRequest.Type;

export const ListSqlSchemasPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ListSQLSchemasRequest,
  sessionId: KernelSessionIdFromString,
});

export const ListSQLTablesRequest = Schema.Struct({
  requestId: Schema.String,
  engine: Schema.String,
  database: Schema.String,
  schema: Schema.String,
  schemaPath: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => [])),
  ),
}).annotate({ identifier: "ListSQLTablesRequest" });
export type ListSQLTablesRequest = typeof ListSQLTablesRequest.Type;

export const ListSqlTablesPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ListSQLTablesRequest,
  sessionId: KernelSessionIdFromString,
});

export const StdinRequest = Schema.Struct({
  text: Schema.String,
}).annotate({ identifier: "StdinRequest" });
export type StdinRequest = typeof StdinRequest.Type;

export const SendStdinPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: StdinRequest,
  sessionId: KernelSessionIdFromString,
});

export const CloseSessionPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: CloseSessionRequest,
});

/**
 * A request to restart a live session's kernel.
 */
export const RestartSessionRequest = Schema.Struct({
  executable: Schema.String,
  workingDirectory: Schema.String,
  createIfMissing: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.sync(() => false)),
  ),
}).annotate({ identifier: "RestartSessionRequest" });
export type RestartSessionRequest = typeof RestartSessionRequest.Type;

export const RestartSessionPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: RestartSessionRequest,
});

/**
 * A request to move a live session to a renamed notebook URI.
 */
export const MoveSessionRequest = Schema.Struct({
  newNotebookUri: Schema.String,
}).annotate({ identifier: "MoveSessionRequest" });
export type MoveSessionRequest = typeof MoveSessionRequest.Type;

export const MoveSessionPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: MoveSessionRequest,
});

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
  marimoVersion: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "SessionInfo" });
export type SessionInfo = typeof SessionInfo.Type;

/**
 * Snapshot of all live sessions owned by this language server.
 */
export const ListSessionsResponse = Schema.Struct({
  sessions: Schema.Array(SessionInfo),
}).annotate({ identifier: "ListSessionsResponse" });
export type ListSessionsResponse = typeof ListSessionsResponse.Type;

export const ListSessionsPayload = Schema.Struct({});

export const ShutdownAllSessionsPayload = Schema.Struct({});

export const ExecuteScratchpadPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ExecuteScratchRequest,
  executable: Schema.String,
  workingDirectory: Schema.String,
  marimoVersion: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
});

export const PackageDescription = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
}).annotate({ identifier: "PackageDescription" });
export type PackageDescription = typeof PackageDescription.Type;

/**
 * Response for ``get-package-list``.
 */
export const ListPackagesResponse = Schema.Struct({
  packages: Schema.Array(PackageDescription),
}).annotate({ identifier: "ListPackagesResponse" });
export type ListPackagesResponse = typeof ListPackagesResponse.Type;

export const GetPackageListPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ListPackagesRequest,
  source: PackageSource,
});

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

export const GetDependencyTreePayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: DependencyTreeRequest,
  source: PackageSource,
});

/**
 * Response for ``serialize``.
 */
export const SerializeResponse = Schema.Struct({
  source: Schema.String,
}).annotate({ identifier: "SerializeResponse" });
export type SerializeResponse = typeof SerializeResponse.Type;

export const SerializePayload = Schema.Struct({
  notebook: NotebookV1,
  appConfig: Schema.Record(Schema.String, Schema.Unknown).pipe(
    Schema.withDecodingDefault(Effect.sync(() => ({}))),
  ),
  header: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
});

export const DeserializePayload = Schema.Struct({
  source: Schema.String,
});

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

export const GetConfigurationPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: GetConfigurationRequest,
});

export const UpdateConfigurationPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: UpdateConfigurationRequest,
});

/**
 * Response for ``set-display-theme``.
 */
export const SetDisplayThemeResponse = Schema.Struct({
  success: Schema.Boolean,
}).annotate({ identifier: "SetDisplayThemeResponse" });
export type SetDisplayThemeResponse = typeof SetDisplayThemeResponse.Type;

export const SetDisplayThemePayload = Schema.Struct({
  theme: Schema.Literals(["dark", "light"]),
});

export const DecodeSavedSessionPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: DecodeSavedSessionRequest,
});

export const ExportAsHTMLRequest = Schema.Struct({
  download: Schema.Boolean,
  files: Schema.Array(Schema.String),
  includeCode: Schema.Boolean,
  assetUrl: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefault(Effect.sync(() => null)),
  ),
}).annotate({ identifier: "ExportAsHTMLRequest" });
export type ExportAsHTMLRequest = typeof ExportAsHTMLRequest.Type;

export const ExportAsHtmlPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ExportAsHTMLRequest,
});

export const ExportAsIpynbPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ExportAsIpynbRequest,
});

/**
 * A request to export the notebook as Markdown.
 */
export const ExportAsMarkdownRequest = Schema.Struct({}).annotate({
  identifier: "ExportAsMarkdownRequest",
});
export type ExportAsMarkdownRequest = typeof ExportAsMarkdownRequest.Type;

export const ExportAsMarkdownPayload = Schema.Struct({
  notebookUri: NotebookIdFromString,
  inner: ExportAsMarkdownRequest,
});

/**
 * Every command accepted by the `marimo.api` transport.
 *
 * Generated from the `API_METHODS` registry in `src/marimo_lsp/api.py`,
 * which is also what the server dispatches and validates against.
 */
export type MarimoApiCall =
  | {
      readonly method: "execute-cells";
      readonly params: typeof ExecuteCellsPayload.Encoded;
    }
  | {
      readonly method: "update-ui-element";
      readonly params: typeof UpdateUiElementPayload.Encoded;
    }
  | {
      readonly method: "set-model-value";
      readonly params: typeof SetModelValuePayload.Encoded;
    }
  | {
      readonly method: "invoke-function";
      readonly params: typeof InvokeFunctionPayload.Encoded;
    }
  | {
      readonly method: "interrupt";
      readonly params: typeof InterruptPayload.Encoded;
    }
  | {
      readonly method: "delete-cell";
      readonly params: typeof DeleteCellPayload.Encoded;
    }
  | {
      readonly method: "list-sql-schemas";
      readonly params: typeof ListSqlSchemasPayload.Encoded;
    }
  | {
      readonly method: "list-sql-tables";
      readonly params: typeof ListSqlTablesPayload.Encoded;
    }
  | {
      readonly method: "send-stdin";
      readonly params: typeof SendStdinPayload.Encoded;
    }
  | {
      readonly method: "close-session";
      readonly params: typeof CloseSessionPayload.Encoded;
    }
  | {
      readonly method: "restart-session";
      readonly params: typeof RestartSessionPayload.Encoded;
    }
  | {
      readonly method: "move-session";
      readonly params: typeof MoveSessionPayload.Encoded;
    }
  | {
      readonly method: "list-sessions";
      readonly params: typeof ListSessionsPayload.Encoded;
    }
  | {
      readonly method: "shutdown-all-sessions";
      readonly params: typeof ShutdownAllSessionsPayload.Encoded;
    }
  | {
      readonly method: "execute-scratchpad";
      readonly params: typeof ExecuteScratchpadPayload.Encoded;
    }
  | {
      readonly method: "get-package-list";
      readonly params: typeof GetPackageListPayload.Encoded;
    }
  | {
      readonly method: "get-dependency-tree";
      readonly params: typeof GetDependencyTreePayload.Encoded;
    }
  | {
      readonly method: "serialize";
      readonly params: typeof SerializePayload.Encoded;
    }
  | {
      readonly method: "deserialize";
      readonly params: typeof DeserializePayload.Encoded;
    }
  | {
      readonly method: "get-configuration";
      readonly params: typeof GetConfigurationPayload.Encoded;
    }
  | {
      readonly method: "update-configuration";
      readonly params: typeof UpdateConfigurationPayload.Encoded;
    }
  | {
      readonly method: "set-display-theme";
      readonly params: typeof SetDisplayThemePayload.Encoded;
    }
  | {
      readonly method: "decode-saved-session";
      readonly params: typeof DecodeSavedSessionPayload.Encoded;
    }
  | {
      readonly method: "export-as-html";
      readonly params: typeof ExportAsHtmlPayload.Encoded;
    }
  | {
      readonly method: "export-as-ipynb";
      readonly params: typeof ExportAsIpynbPayload.Encoded;
    }
  | {
      readonly method: "export-as-markdown";
      readonly params: typeof ExportAsMarkdownPayload.Encoded;
    };

type Execute<E, R> = (call: MarimoApiCall) => Effect.Effect<unknown, E, R>;

/**
 * Validate the outgoing params against the payload schema (the wire/Encoded
 * side, so defaulted fields stay omittable), send them verbatim, and parse
 * the response against the method's success schema.
 */
const dispatch = <Payload extends Schema.Top, Success extends Schema.Top, E, R>(
  execute: Execute<E, R>,
  call: MarimoApiCall & { readonly params: Payload["Encoded"] },
  payload: Payload,
  success: Success,
): Effect.Effect<
  Success["Type"],
  E | Schema.SchemaError,
  R | Payload["DecodingServices"] | Success["DecodingServices"]
> =>
  Effect.andThen(
    Schema.decodeEffect(payload)(call.params),
    Effect.flatMap(execute(call), Schema.decodeUnknownEffect(success)),
  );

/**
 * Typed `marimo.api` client surface: one method per registry entry.
 *
 * Each method encodes its payload, dispatches `{ method, params }` over
 * `execute`, and parses the response against the method's success schema —
 * both sides of the wire are earned, not asserted.
 */
export const makeApiClient = <E, R>(execute: Execute<E, R>) => ({
  executeCells: (params: typeof ExecuteCellsPayload.Encoded) =>
    dispatch(
      execute,
      { method: "execute-cells", params },
      ExecuteCellsPayload,
      Schema.Null,
    ),
  updateUiElement: (params: typeof UpdateUiElementPayload.Encoded) =>
    dispatch(
      execute,
      { method: "update-ui-element", params },
      UpdateUiElementPayload,
      Schema.Null,
    ),
  setModelValue: (params: typeof SetModelValuePayload.Encoded) =>
    dispatch(
      execute,
      { method: "set-model-value", params },
      SetModelValuePayload,
      Schema.Null,
    ),
  invokeFunction: (params: typeof InvokeFunctionPayload.Encoded) =>
    dispatch(
      execute,
      { method: "invoke-function", params },
      InvokeFunctionPayload,
      Schema.Null,
    ),
  interrupt: (params: typeof InterruptPayload.Encoded) =>
    dispatch(
      execute,
      { method: "interrupt", params },
      InterruptPayload,
      Schema.Null,
    ),
  deleteCell: (params: typeof DeleteCellPayload.Encoded) =>
    dispatch(
      execute,
      { method: "delete-cell", params },
      DeleteCellPayload,
      Schema.Null,
    ),
  listSqlSchemas: (params: typeof ListSqlSchemasPayload.Encoded) =>
    dispatch(
      execute,
      { method: "list-sql-schemas", params },
      ListSqlSchemasPayload,
      Schema.Null,
    ),
  listSqlTables: (params: typeof ListSqlTablesPayload.Encoded) =>
    dispatch(
      execute,
      { method: "list-sql-tables", params },
      ListSqlTablesPayload,
      Schema.Null,
    ),
  sendStdin: (params: typeof SendStdinPayload.Encoded) =>
    dispatch(
      execute,
      { method: "send-stdin", params },
      SendStdinPayload,
      Schema.Null,
    ),
  closeSession: (params: typeof CloseSessionPayload.Encoded) =>
    dispatch(
      execute,
      { method: "close-session", params },
      CloseSessionPayload,
      Schema.Null,
    ),
  restartSession: (params: typeof RestartSessionPayload.Encoded) =>
    dispatch(
      execute,
      { method: "restart-session", params },
      RestartSessionPayload,
      Schema.Null,
    ),
  moveSession: (params: typeof MoveSessionPayload.Encoded) =>
    dispatch(
      execute,
      { method: "move-session", params },
      MoveSessionPayload,
      Schema.Null,
    ),
  listSessions: (params: typeof ListSessionsPayload.Encoded) =>
    dispatch(
      execute,
      { method: "list-sessions", params },
      ListSessionsPayload,
      ListSessionsResponse,
    ),
  shutdownAllSessions: (params: typeof ShutdownAllSessionsPayload.Encoded) =>
    dispatch(
      execute,
      { method: "shutdown-all-sessions", params },
      ShutdownAllSessionsPayload,
      Schema.Null,
    ),
  executeScratchpad: (params: typeof ExecuteScratchpadPayload.Encoded) =>
    dispatch(
      execute,
      { method: "execute-scratchpad", params },
      ExecuteScratchpadPayload,
      Schema.Null,
    ),
  getPackageList: (params: typeof GetPackageListPayload.Encoded) =>
    dispatch(
      execute,
      { method: "get-package-list", params },
      GetPackageListPayload,
      ListPackagesResponse,
    ),
  getDependencyTree: (params: typeof GetDependencyTreePayload.Encoded) =>
    dispatch(
      execute,
      { method: "get-dependency-tree", params },
      GetDependencyTreePayload,
      DependencyTreeResponse,
    ),
  serialize: (params: typeof SerializePayload.Encoded) =>
    dispatch(
      execute,
      { method: "serialize", params },
      SerializePayload,
      SerializeResponse,
    ),
  deserialize: (params: typeof DeserializePayload.Encoded) =>
    dispatch(
      execute,
      { method: "deserialize", params },
      DeserializePayload,
      DeserializeResult,
    ),
  getConfiguration: (params: typeof GetConfigurationPayload.Encoded) =>
    dispatch(
      execute,
      { method: "get-configuration", params },
      GetConfigurationPayload,
      GetConfigurationResponse,
    ),
  updateConfiguration: (params: typeof UpdateConfigurationPayload.Encoded) =>
    dispatch(
      execute,
      { method: "update-configuration", params },
      UpdateConfigurationPayload,
      MarimoConfig,
    ),
  setDisplayTheme: (params: typeof SetDisplayThemePayload.Encoded) =>
    dispatch(
      execute,
      { method: "set-display-theme", params },
      SetDisplayThemePayload,
      SetDisplayThemeResponse,
    ),
  decodeSavedSession: (params: typeof DecodeSavedSessionPayload.Encoded) =>
    dispatch(
      execute,
      { method: "decode-saved-session", params },
      DecodeSavedSessionPayload,
      DecodeSavedSessionResponse,
    ),
  exportAsHtml: (params: typeof ExportAsHtmlPayload.Encoded) =>
    dispatch(
      execute,
      { method: "export-as-html", params },
      ExportAsHtmlPayload,
      Schema.String,
    ),
  exportAsIpynb: (params: typeof ExportAsIpynbPayload.Encoded) =>
    dispatch(
      execute,
      { method: "export-as-ipynb", params },
      ExportAsIpynbPayload,
      Schema.String,
    ),
  exportAsMarkdown: (params: typeof ExportAsMarkdownPayload.Encoded) =>
    dispatch(
      execute,
      { method: "export-as-markdown", params },
      ExportAsMarkdownPayload,
      Schema.String,
    ),
});
