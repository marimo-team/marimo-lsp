import { Data, Effect } from "effect";
import * as vscode from "vscode";
import { notebookType } from "../types.ts";

export class VsCodeWorkspaceError extends Data.TaggedError(
  "VsCodeWorkspaceError",
)<{
  cause: unknown;
}> {}

export class VsCodeWorkspace extends Effect.Service<VsCodeWorkspace>()(
  "VsCodeWorkspace",
  {
    sync: () => {
      const api = vscode.workspace;

      return {
        createEmptyMarimoNotebook() {
          return Effect.tryPromise({
            try: () =>
              api.openNotebookDocument(
                notebookType,
                new vscode.NotebookData([
                  new vscode.NotebookCellData(
                    vscode.NotebookCellKind.Code,
                    "",
                    "python",
                  ),
                ]),
              ),
            catch: (cause) => new VsCodeWorkspaceError({ cause }),
          });
        },
      };
    },
  },
) {}
