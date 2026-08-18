import { Brand } from "effect";

export type NotebookDocumentSessionId = symbol &
  Brand.Brand<"NotebookDocumentSessionId">;
const NotebookDocumentSessionId = Brand.nominal<NotebookDocumentSessionId>();

export function makeNotebookDocumentSessionId(): NotebookDocumentSessionId {
  return NotebookDocumentSessionId(Symbol("NotebookDocumentSession"));
}
