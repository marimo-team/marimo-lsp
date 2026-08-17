import { Effect } from "effect";
import type * as vscode from "vscode";

import { type NotebookDocumentSession } from "../../notebook/NotebookDocumentSessions.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import { makeNotebookDocumentSessionId } from "../../schemas/SessionIds.ts";

export function makeTestNotebookDocumentSession(
  document: vscode.NotebookDocument,
): NotebookDocumentSession {
  return {
    id: makeNotebookDocumentSessionId(),
    notebookId: MarimoNotebookDocument.from(document).id,
    document,
    ended: Effect.never,
  };
}
