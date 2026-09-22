import { Context, Effect, Layer, Queue, Stream } from "effect";
import type * as vscode from "vscode";

import { acquireDisposable } from "../lib/acquireDisposable.ts";
import { VsCode } from "../platform/VsCode.ts";
import type { RendererCommand, RendererReceiveMessage } from "../types.ts";

/**
 * Manages communication with the marimo notebook renderer.
 */
export interface Interface {
  readonly rendererId: string;
  readonly postMessage: (
    message: RendererReceiveMessage,
    editor?: vscode.NotebookEditor,
  ) => Effect.Effect<boolean>;
  readonly messages: Stream.Stream<{
    editor: vscode.NotebookEditor;
    message: RendererCommand;
  }>;
}

export class Service extends Context.Service<Service, Interface>()(
  "@marimo/NotebookRenderer",
) {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const code = yield* VsCode;
    // Defined in package.json
    const rendererId = "marimo-renderer";
    const channel = yield* code.notebooks.createRendererMessaging(rendererId);

    const postMessage = Effect.fn("NotebookRenderer.postMessage")(function* (
      message: RendererReceiveMessage,
      editor?: vscode.NotebookEditor,
    ) {
      return yield* Effect.promise(() => channel.postMessage(message, editor));
    });
    const messages = Stream.callback<{
      editor: vscode.NotebookEditor;
      message: RendererCommand;
    }>((queue) =>
      acquireDisposable(() =>
        channel.onDidReceiveMessage((msg) => Queue.offerUnsafe(queue, msg)),
      ),
    );

    return Service.of({ rendererId, postMessage, messages });
  }),
);
