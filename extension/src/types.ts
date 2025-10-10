import type { components as Api } from "@marimo-team/openapi/src/api";
import { Brand } from "effect";
import type * as vscode from "vscode";
import type * as lsp from "vscode-languageclient/node";
import type { MarimoNotebook } from "./schemas.ts";

export type { CellRuntimeState } from "@marimo-team/frontend/unstable_internal/core/cells/types.ts";

type Schemas = Api["schemas"];

export type MessageOperation = Schemas["KnownUnions"]["operation"];
export type MessageOperationOf<T extends MessageOperation["op"]> = Extract<
  MessageOperation,
  { op: T }
>;
export type CellMessage = MessageOperationOf<"cell-op">;
export type VariableValuesOp = MessageOperationOf<"variable-values">;
export type VariablesOp = MessageOperationOf<"variables">;
export type DataColumnPreviewOp = MessageOperationOf<"data-column-preview">;
export type DataSourceConnectionsOp =
  MessageOperationOf<"data-source-connections">;
export type DatasetsOp = MessageOperationOf<"datasets">;
export type SqlTablePreviewOp = MessageOperationOf<"sql-table-preview">;
export type SqlTableListPreviewOp =
  MessageOperationOf<"sql-table-list-preview">;

export type MarimoConfig = Schemas["MarimoConfig"];

export type NotebookUri = Brand.Branded<string, "NotebookUri">;

// Only way to get our NotebookUri type is from the server or a vscode.NotebookDocument
const NotebookUri = Brand.nominal<NotebookUri>();
export function getNotebookUri(doc: vscode.NotebookDocument): NotebookUri {
  return NotebookUri(doc.uri.toString());
}

interface NotebookScoped<T> {
  notebookUri: NotebookUri;
  inner: T;
}

interface SessionScoped<T> extends NotebookScoped<T> {
  executable: string;
}

type RunRequest = Schemas["RunRequest"];
type SetUIElementValueRequest = Schemas["SetUIElementValueRequest"];
type FunctionCallRequest = Schemas["FunctionCallRequest"];
interface DeserializeRequest {
  source: string;
}
interface SerializeRequest {
  notebook: typeof MarimoNotebook.Type;
}
interface DebugAdapterRequest {
  sessionId: string;
  message: vscode.DebugProtocolMessage;
}
// biome-ignore lint/complexity/noBannedTypes: We need this for over the wire
type InterruptRequest = {};
// biome-ignore lint/complexity/noBannedTypes: We need this for over the wire
type ListPackagesRequest = {};
// biome-ignore lint/complexity/noBannedTypes: We need this for over the wire
type DependencyTreeRequest = {};
// biome-ignore lint/complexity/noBannedTypes: We need this for over the wire
type GetConfigurationRequest = {};
interface UpdateConfigurationRequest {
  config: Record<string, unknown>;
}

// API methods routed through marimo.api
type MarimoApiMethodMap = {
  run: SessionScoped<RunRequest>;
  set_ui_element_value: NotebookScoped<SetUIElementValueRequest>;
  function_call_request: NotebookScoped<FunctionCallRequest>;
  dap: NotebookScoped<DebugAdapterRequest>;
  interrupt: NotebookScoped<InterruptRequest>;
  serialize: SerializeRequest;
  deserialize: DeserializeRequest;
  get_package_list: SessionScoped<ListPackagesRequest>;
  get_dependency_tree: SessionScoped<DependencyTreeRequest>;
  get_configuration: NotebookScoped<GetConfigurationRequest>;
  update_configuration: NotebookScoped<UpdateConfigurationRequest>;
};

type ApiRequest<K extends keyof MarimoApiMethodMap> = {
  [M in keyof MarimoApiMethodMap]: {
    method: M;
    params: MarimoApiMethodMap[M];
  };
}[K];

// client -> language server
type MarimoCommandMap = {
  "marimo.api": ApiRequest<keyof MarimoApiMethodMap>;
  "marimo.convert": { uri: string };
};

type MarimoCommandMessageOf<K extends keyof MarimoCommandMap> = {
  [C in keyof MarimoCommandMap]: {
    command: C;
    params: MarimoCommandMap[C];
  };
}[K];

/** Subset of API methods allowed to be dispatched by the renderer */
type RendererCommandMap = {
  set_ui_element_value: MarimoApiMethodMap["set_ui_element_value"]["inner"];
  function_call_request: MarimoApiMethodMap["function_call_request"]["inner"];
};
type RendererCommandMessageOf<K extends keyof RendererCommandMap> = {
  [C in keyof RendererCommandMap]: {
    command: C;
    params: RendererCommandMap[C];
  };
}[K];

export type MarimoCommand = MarimoCommandMessageOf<keyof MarimoCommandMap>;

// renderer -> extension
export type RendererCommand = RendererCommandMessageOf<
  keyof RendererCommandMap
>;

// extension -> renderer
export type RendererReceiveMessage =
  | MessageOperationOf<"remove-ui-elements">
  | MessageOperationOf<"send-ui-element-message">
  | MessageOperationOf<"function-call-result">;

// Language server -> client
type MarimoNotificationMap = {
  "marimo/operation": { notebookUri: NotebookUri; operation: MessageOperation };
  "marimo/dap": { sessionId: string; message: vscode.DebugProtocolMessage };
  "window/logMessage": lsp.LogMessageParams;
};
export type MarimoNotification = keyof MarimoNotificationMap;
export type MarimoNotificationOf<K extends MarimoNotification> = {
  [C in MarimoNotification]: MarimoNotificationMap[C];
}[K];
