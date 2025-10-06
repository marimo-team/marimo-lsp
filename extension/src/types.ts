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

// client -> language server
type MarimoCommandMap = {
  "marimo.run": SessionScoped<RunRequest>;
  "marimo.set_ui_element_value": NotebookScoped<SetUIElementValueRequest>;
  "marimo.function_call_request": NotebookScoped<FunctionCallRequest>;
  "marimo.dap": NotebookScoped<DebugAdapterRequest>;
  "marimo.interrupt": NotebookScoped<InterruptRequest>;
  "marimo.serialize": SerializeRequest;
  "marimo.deserialize": DeserializeRequest;
};

type MarimoCommandMessageOf<K extends keyof MarimoCommandMap> = {
  [C in keyof MarimoCommandMap]: {
    command: C;
    params: MarimoCommandMap[C];
  };
}[K];

/** Subset of commands allowed to be dispatched by the renderer */
type RendererCommandMap = {
  [K in
    | "marimo.set_ui_element_value"
    | "marimo.function_call_request"]: MarimoCommandMap[K]["inner"];
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
