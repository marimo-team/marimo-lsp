import { Effect } from "effect";
import * as vscode from "vscode";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";

/**
 * Manages communication with the marimo notebook renderer.
 */
export class NotebookRenderer extends Effect.Service<NotebookRenderer>()(
  "NotebookRenderer",
  {
    sync: () => {
      // Defined in package.json
      const rendererId = "marimo-renderer";
      const channel = vscode.notebooks.createRendererMessaging(rendererId);
      return {
        rendererId,
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
