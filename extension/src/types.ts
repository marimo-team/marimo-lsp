import { components as Api } from "@marimo-team/openapi/src/api";
import type { NotebookSerialization } from "./schemas.ts";

type Schemas = Api["schemas"];

export type MessageOperation = Schemas["MessageOperation"];
export type MessageOperationType = MessageOperation["name"];
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
};

export const notebookType = "marimo-notebook";
