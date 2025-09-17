import type { components as Api } from "@marimo-team/openapi/src/api";
import type * as vscode from "vscode";

import type { NotebookSerialization } from "./schemas.ts";

type Schemas = Api["schemas"];

export type MessageOperation = Schemas["KnownUnions"]["operation"];
type MessageOperationOf<T extends MessageOperation["op"]> = Extract<
  MessageOperation,
  { op: T }
>;
export type CellMessage = MessageOperationOf<"cell-op">;

interface NotebookScoped<T> {
  notebookUri: string;
  inner: T;
}

interface SessionScoped<T> extends NotebookScoped<T> {
  executable: string;
}

type RunRequest = Schemas["RunRequest"];
type SetUIElementValueRequest = Schemas["SetUIElementValueRequest"];
interface DeserializeRequest {
  source: string;
}
interface SerializeRequest {
  notebook: NotebookSerialization;
}
interface DebugAdapterRequest {
  sessionId: string;
  message: vscode.DebugProtocolMessage;
}

// client -> language server
type MarimoCommandMap = {
  "marimo.run": SessionScoped<RunRequest>;
  "marimo.set_ui_element_value": NotebookScoped<SetUIElementValueRequest>;
  "marimo.dap": NotebookScoped<DebugAdapterRequest>;
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
  [K in "marimo.set_ui_element_value"]: MarimoCommandMap[K]["inner"];
};
type RendererCommandMessageOf<K extends keyof RendererCommandMap> = {
  [C in keyof RendererCommandMap]: {
    command: C;
    params: RendererCommandMap[C];
  };
}[K];

export type MarimoCommand = MarimoCommandMessageOf<keyof MarimoCommandMap>;
export type RendererCommand = RendererCommandMessageOf<
  keyof RendererCommandMap
>;
export const notebookType = "marimo-notebook";

// Language server -> client
type MarimoNotificationMap = {
  "marimo/operation": { notebookUri: string; operation: MessageOperation };
  "marimo/dap": { sessionId: string; message: vscode.DebugProtocolMessage };
};
export type MarimoNotification = keyof MarimoNotificationMap;
export type MarimoNotificationOf<K extends MarimoNotification> = {
  [C in MarimoNotification]: MarimoNotificationMap[C];
}[K];
