import { Effect, Layer, pipe, Stream } from "effect";
import * as vscode from "vscode";
import { assert } from "./assert.ts";
import { NotebookControllerManager } from "./notebookControllerManager.ts";
import * as ops from "./operations.ts";
import { MarimoLanguageClient } from "./services/MarimoLanguageClient.ts";
import { MarimoNotebookRenderer } from "./services/MarimoNotebookRenderer.ts";

export const KernelManagerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    const marimo = yield* MarimoLanguageClient;
    const renderer = yield* MarimoNotebookRenderer;
    const manager = yield* NotebookControllerManager;

    const contexts = new Map<
      string,
      Omit<ops.OperationContext, "controller" | "renderer">
    >();

    // renderer (i.e., front end) -> kernel
    yield* renderer.messages().pipe(
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
      Effect.forkDaemon,
    );

    // kernel -> renderer
    yield* pipe(
      marimo.streamOf("marimo/operation"),
      Stream.tap((msg) => Effect.logTrace(msg)),
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
      Effect.forkDaemon,
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Teardown");
        contexts.clear();
      }),
    );

    yield* Effect.logInfo("Intialized");
  }).pipe(Effect.annotateLogs("component", "kernel-manager")),
);
