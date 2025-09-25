import {
  Effect,
  Fiber,
  type Layer,
  Logger,
  LogLevel,
  pipe,
  Stream,
} from "effect";
import * as vscode from "vscode";

import { assert } from "./assert.ts";
import { createNotebookControllerManager } from "./notebookControllerManager.ts";
import * as ops from "./operations.ts";
import { MarimoLanguageClient, MarimoNotebookRenderer } from "./services.ts";

export function kernelManager(
  layer: Layer.Layer<
    MarimoLanguageClient | MarimoNotebookRenderer,
    never,
    never
  >,
  options: { signal: AbortSignal },
) {
  const program = Effect.gen(function* () {
    const marimo = yield* MarimoLanguageClient;
    const renderer = yield* MarimoNotebookRenderer;

    const manager = createNotebookControllerManager(layer, options);

    // renderer (i.e., front end) -> kernel
    yield* pipe(
      renderer.messages(),
      Stream.mapEffect(({ editor, message }) =>
        Effect.gen(function* () {
          yield* Effect.logTrace(message.command);
          yield* marimo.setUiElementValue({
            notebookUri: editor.notebook.uri.toString(),
            inner: message.params,
          });
        }).pipe(
          Effect.annotateLogs({
            notebookUri: editor.notebook.uri.toString(),
            params: message.params,
          }),
        ),
      ),
      Stream.runDrain,
      Effect.catchAllCause((cause) =>
        Effect.logError("Renderer command failed", cause),
      ),
      Effect.annotateLogs("stream", "renderer"),
      Effect.fork,
    );

    const contexts = new Map<
      string,
      Omit<ops.OperationContext, "controller" | "renderer">
    >();

    // kernel -> renderer
    yield* pipe(
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

          return yield* ops
            .routeOperation({ ...context, controller }, operation)
            .pipe(
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
      Effect.fork,
    );

    yield* Effect.addFinalizer(() => Effect.sync(() => contexts.clear()));

    // Keep effect alive until interrupted
    return yield* Effect.never;
  });

  const fiber = Effect.runFork<void, never>(
    pipe(
      program,
      Effect.scoped,
      Effect.annotateLogs("component", "kernel-manager"),
      Logger.withMinimumLogLevel(LogLevel.All),
      Effect.provide(layer),
    ),
  );

  options.signal.addEventListener("abort", () =>
    // kill the fiber
    Effect.runPromise(Fiber.interrupt(fiber)),
  );
}
