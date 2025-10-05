import { Effect } from "effect";
import type * as vscode from "vscode";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";
import { VsCode } from "./VsCode.ts";

/**
 * Manages communication with the marimo notebook renderer.
 */
export class NotebookRenderer extends Effect.Service<NotebookRenderer>()(
  "NotebookRenderer",
  {
    dependencies: [VsCode.Default],
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
    }).pipe(Effect.annotateLogs("service", "NotebookRenderer")),
  },
) {}
