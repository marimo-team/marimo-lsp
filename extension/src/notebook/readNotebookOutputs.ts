import * as NodePath from "node:path";

import { Context } from "effect";

import { MarimoClient } from "../lsp/MarimoClient.ts";
import type { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";

type MarimoClientService = Context.Service.Shape<typeof MarimoClient>;

/** Ask the LSP to replay live output or a conventional cold sidecar. */
export const readNotebookOutputs = (
  notebook: MarimoNotebookDocument,
  marimo: MarimoClientService,
) => {
  const sessionCachePath = conventionalSessionCachePath(notebook);
  return marimo.readNotebookOutputs({
    notebookUri: notebook.id,
    sessionCachePath,
  });
};

export const conventionalSessionCachePath = (
  notebook: MarimoNotebookDocument,
): string | null => {
  if (
    notebook.isUntitled ||
    !["file", "vscode-remote"].includes(notebook.uri.scheme) ||
    NodePath.extname(notebook.uri.fsPath).toLowerCase() !== ".py"
  ) {
    return null;
  }
  return NodePath.join(
    NodePath.dirname(notebook.uri.fsPath),
    "__marimo__",
    "session",
    `${NodePath.basename(notebook.uri.fsPath)}.json`,
  );
};
