import { Effect, Stream } from "effect";
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
        messages() {
          return Stream.asyncPush<{
            editor: vscode.NotebookEditor;
            message: RendererCommand;
          }>(
            Effect.fnUntraced(function* (emit) {
              const disposer = channel.onDidReceiveMessage((msg) =>
                emit.single(msg),
              );
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => disposer.dispose()),
              );
            }),
          );
        },
      };
    },
  },
) {}
