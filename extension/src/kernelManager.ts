import {
  Effect,
  Fiber,
  Logger,
  LogLevel,
  type Layer,
  pipe,
  Stream,
} from "effect";
import * as vscode from "vscode";

import { assert } from "./assert.ts";
import { createNotebookControllerManager } from "./notebookControllerManager.ts";
import * as ops from "./operations.ts";
import { MarimoLanguageClient } from "./services.ts";
import type { RendererCommand } from "./types.ts";

export function kernelManager(
  layer: Layer.Layer<MarimoLanguageClient>,
  options: { signal: AbortSignal },
) {
  const program = Effect.gen(function* () {
    const marimo = yield* MarimoLanguageClient;

    const manager = createNotebookControllerManager(layer, options);
    const channel = vscode.notebooks.createRendererMessaging("marimo-renderer");

    const rendererFiber = yield* pipe(
      streamOfRenderingChannel(channel),
      Stream.mapEffect(({ editor, message }) =>
        pipe(
          Effect.logTrace(message.command),
          Effect.annotateLogs({
            notebookUri: editor.notebook.uri.toString(),
            params: message.params,
          }),
          Effect.andThen(
            marimo.setUiElementValue({
              notebookUri: editor.notebook.uri.toString(),
              inner: message.params,
            }),
          ),
        ),
      ),
      Stream.runDrain,
      Effect.catchAllCause((cause) =>
        Effect.logError("Renderer command failed", cause),
      ),
      Effect.annotateLogs("stream", "renderer"),
      Effect.forkDaemon,
    );

    const contexts = new Map<
      string,
      Omit<ops.OperationContext, "controller">
    >();

    const operationFiber = yield* pipe(
      marimo.streamOf("marimo/operation"),
      Stream.mapEffect(({ notebookUri, operation }) =>
        Effect.gen(function* () {
          let context = contexts.get(notebookUri);

          if (!context) {
            const notebook = vscode.workspace.notebookDocuments.find(
              (doc) => doc.uri.toString() === notebookUri,
            );
            assert(notebook, `Expected notebook document for ${notebookUri}`);
            context = { notebook, executions: new Map() };
            contexts.set(notebookUri, context);
            yield* Effect.logInfo("Created new context for notebook").pipe(
              Effect.annotateLogs("notebookUri", notebookUri),
            );
          }

          const controller = manager.getSelectedController(context.notebook);
          assert(controller, `Expected notebook controller for ${notebookUri}`);

          yield* Effect.logTrace("Routing operation").pipe(
            Effect.annotateLogs({ notebookUri, op: operation.op }),
          );

          return yield* pipe(
            Effect.tryPromise(() =>
              ops.route({ ...context, controller }, operation),
            ),
            Effect.withSpan(`op:${operation.op}`, {
              attributes: { notebookUri },
            }),
            Effect.catchAllCause((cause) =>
              pipe(
                Effect.logError("Operation routing failed", cause),
                Effect.annotateLogs({ notebookUri, op: operation.op }),
              ),
            ),
          );
        }),
      ),
      Stream.runDrain,
      Effect.annotateLogs("stream", "operations"),
      Effect.forkDaemon,
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logDebug("Shutting down fibers");
        yield* Fiber.interrupt(rendererFiber);
        yield* Fiber.interrupt(operationFiber);
      }),
    );

    // Keep effect alive until interrupted
    yield* Effect.never;
  });

  return Effect.runPromise(
    pipe(
      program,
      Effect.annotateLogs("componenet", "kernel-manager"),
      Logger.withMinimumLogLevel(LogLevel.All),
      Effect.scoped,
      Effect.provide(layer),
    ),
    { signal: options.signal },
  );
}

function streamOfRenderingChannel(channel: vscode.NotebookRendererMessaging) {
  return Stream.async<{
    editor: vscode.NotebookEditor;
    message: RendererCommand;
  }>((emit) => {
    const disposer = channel.onDidReceiveMessage(emit.single.bind(emit));
    return Effect.sync(() => {
      disposer.dispose();
    });
  });
}
