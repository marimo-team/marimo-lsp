import type { components as Api } from "@marimo-team/openapi/src/api";
import type * as vscode from "vscode";

import type { NotebookSerialization } from "./schemas.ts";

type Schemas = Api["schemas"];

export type MessageOperation = Schemas["KnownUnions"]["operation"];
export type MessageOperationType = MessageOperation["op"];
export type MessageOperationData<T extends MessageOperationType> = Omit<
  Extract<MessageOperation, { name: T }>,
  "name"
>;

type WithNotebookUri<T> = T & { notebookUri: string };

export type RequestMap = {
  "marimo.run": WithNotebookUri<Schemas["RunRequest"]>;
  "marimo.set_ui_element_value": WithNotebookUri<
    Schemas["SetUIElementValueRequest"]
  >;
  "marimo.serialize": { notebook: NotebookSerialization };
  "marimo.deserialize": { source: string };
  "marimo.dap": {
    sessionId: string;
    notebookUri: string;
    message: vscode.DebugProtocolMessage;
  };
};

export const notebookType = "marimo-notebook";
