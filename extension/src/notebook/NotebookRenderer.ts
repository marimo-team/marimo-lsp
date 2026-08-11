import { Context, Effect, Layer, Queue, Stream } from "effect";
import type * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";

/**
 * Manages communication with the marimo notebook renderer.
 */
export class NotebookRenderer extends Context.Service<NotebookRenderer>()(
  "NotebookRenderer",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      // Defined in package.json
      const rendererId = "marimo-renderer";
      const channel = yield* code.notebooks.createRendererMessaging(rendererId);
      return {
        rendererId,
        postMessage(
          message: RendererReceiveMessage,
          editor?: vscode.NotebookEditor,
        ): Effect.Effect<boolean> {
          return Effect.promise(() => channel.postMessage(message, editor));
        },
        messages: Stream.callback<{
          editor: vscode.NotebookEditor;
          message: RendererCommand;
        }>((queue) =>
          acquireDisposable(() =>
            channel.onDidReceiveMessage((msg) => Queue.offerUnsafe(queue, msg)),
          ),
        ),
      };
    }).pipe(Effect.annotateLogs("service", "NotebookRenderer")),
  },
) {
  static readonly layer = Layer.effect(this, this.make);
}
