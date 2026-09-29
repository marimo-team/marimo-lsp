import { Scope } from "effect";
import type * as vscode from "vscode";

import * as NotebookDocumentSessions from "../../notebook/NotebookDocumentSessions.ts";
import { MarimoNotebookDocument } from "../../schemas/MarimoNotebookDocument.ts";
import { makeNotebookDocumentSessionId } from "../../schemas/SessionIds.ts";

export function makeTestNotebookDocumentSession(
  document: vscode.NotebookDocument,
): NotebookDocumentSessions.Session {
  return {
    id: makeNotebookDocumentSessionId(),
    notebookId: MarimoNotebookDocument.from(document).id,
    document,
    scope: Scope.makeUnsafe(),
  };
}
