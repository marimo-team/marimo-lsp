import { Effect, FiberSet, Layer } from "effect";
import * as vscode from "vscode";
import { assert } from "../assert.ts";
import * as ops from "../operations.ts";
import { MarimoLanguageClient } from "../services/MarimoLanguageClient.ts";
import { MarimoNotebookControllerManager } from "../services/MarimoNotebookControllerManager.ts";
import { MarimoNotebookRenderer } from "../services/MarimoNotebookRenderer.ts";

export const KernelManagerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Setting up kernel manager").pipe(
      Effect.annotateLogs({ component: "kernel-manager" }),
    );
    const marimo = yield* MarimoLanguageClient;
    const renderer = yield* MarimoNotebookRenderer;
    const manager = yield* MarimoNotebookControllerManager;

    const contexts = new Map<
      string,
      Omit<ops.OperationContext, "controller" | "renderer">
    >();

    const runFork = yield* FiberSet.makeRuntime<MarimoNotebookRenderer>();

    yield* marimo.onNotification("marimo/operation", (msg) =>
      runFork(
        Effect.gen(function* () {
          const { notebookUri, operation } = msg;
          let context = contexts.get(notebookUri);

          if (!context) {
            const notebook = vscode.workspace.notebookDocuments.find(
              (doc) => doc.uri.toString() === notebookUri,
            );
            assert(notebook, `Expected notebook document for ${notebookUri}`);
            context = { notebook, executions: new Map() };
            contexts.set(notebookUri, context);
            yield* Effect.logInfo("Created new context for notebook").pipe(
              Effect.annotateLogs({ notebookUri }),
            );
          }

          const controller = manager.getSelectedController(context.notebook);
          assert(controller, `Expected notebook controller for ${notebookUri}`);

          return yield* ops
            .routeOperation({ ...context, controller }, operation)
            .pipe(
              Effect.withSpan(`op:${operation.op}`, {
                attributes: { notebookUri },
              }),
              Effect.catchAllCause((cause) =>
                Effect.logError("Operation routing failed", cause).pipe(
                  Effect.annotateLogs({ notebookUri, op: operation.op }),
                ),
              ),
            );
        }),
      ),
    );

    // renderer (i.e., front end) -> kernel
    yield* renderer.onDidReceiveMessage(({ editor, message }) =>
      runFork(
        Effect.gen(function* () {
          yield* Effect.logTrace("Renderer command").pipe(
            Effect.annotateLogs({
              command: message.command,
              notebookUri: editor.notebook.uri.toString(),
            }),
          );
          yield* marimo.setUiElementValue({
            notebookUri: editor.notebook.uri.toString(),
            inner: message.params,
          });
        }),
      ),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Tearing down kernel manager").pipe(
          Effect.annotateLogs({ component: "kernel-manager" }),
        );
        contexts.clear();
      }),
    );

    yield* Effect.logInfo("Kernel manager initialized").pipe(
      Effect.annotateLogs({ component: "kernel-manager" }),
    );
  }),
);
