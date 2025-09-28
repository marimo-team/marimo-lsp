import { Effect } from "effect";
import * as vscode from "vscode";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";

export class MarimoNotebookRenderer extends Effect.Service<MarimoNotebookRenderer>()(
  "MarimoNotebookRenderer",
  {
    sync: () => {
      const channel =
        vscode.notebooks.createRendererMessaging("marimo-renderer");
      return {
        postMessage(
          message: RendererReceiveMessage,
          editor?: vscode.NotebookEditor,
        ): Effect.Effect<boolean, never, never> {
          return Effect.promise(() => channel.postMessage(message, editor));
        },
        onDidReceiveMessage(
          cb: (msg: {
            editor: vscode.NotebookEditor;
            message: RendererCommand;
          }) => void,
        ) {
          return Effect.acquireRelease(
            Effect.sync(() => channel.onDidReceiveMessage((msg) => cb(msg))),
            (disposable) => Effect.sync(() => disposable.dispose()),
          );
        },
      };
    },
  },
) {}
