import { Effect, Stream } from "effect";
import type * as vscode from "vscode";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Manages communication with the marimo notebook renderer.
 */
export class NotebookRenderer extends Effect.Service<NotebookRenderer>()(
  "NotebookRenderer",
  {
    effect: Effect.gen(function* () {
      const code = yield* VsCode;
      // Defined in package.json
      const rendererId = "marimo-renderer";
      const channel = yield* code.notebooks.createRendererMessaging(rendererId);
      return {
        rendererId,
        postMessage(
          message: RendererReceiveMessage,
          editor?: vscode.NotebookEditor,
        ): Effect.Effect<boolean, never, never> {
          return Effect.promise(() => channel.postMessage(message, editor));
        },
        messages(): Stream.Stream<{
          editor: vscode.NotebookEditor;
          message: RendererCommand;
        }> {
          return Stream.asyncPush((emit) =>
            Effect.acquireRelease(
              Effect.sync(() =>
                channel.onDidReceiveMessage((msg) => emit.single(msg)),
              ),
              (disposable) => Effect.sync(() => disposable.dispose()),
            ),
          );
        },
      };
    }).pipe(Effect.annotateLogs("service", "NotebookRenderer")),
  },
) {}
