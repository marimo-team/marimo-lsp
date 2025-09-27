import { Effect, type Scope, Stream } from "effect";
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
        messages(): Stream.Stream<
          { editor: vscode.NotebookEditor; message: RendererCommand },
          never,
          Scope.Scope
        > {
          return Stream.async((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                channel.onDidReceiveMessage((msg) => emit.single(msg)),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
          );
        },
      };
    },
  },
) {}
