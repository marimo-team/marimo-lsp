import { Effect, FiberSet, Layer, Option } from "effect";
import * as vscode from "vscode";
import { assert } from "../assert.ts";
import * as ops from "../operations.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookControllers } from "../services/NotebookControllers.ts";
import { NotebookRenderer } from "../services/NotebookRenderer.ts";

/**
 * Orchestrates kernel operations for marimo notebooks by composing
 * MarimoLanguageClient, MarimoNotebookRenderer, and MarimoNotebookControllers.
 *
 * Receives `marimo/operations` from marimo-lsp and prepares cell executions.
 *
 * Receives messages from front end (renderer), and sends back to kernel.
 */
export const KernelManagerLive = Layer.scopedDiscard(
  Effect.gen(function* () {
    yield* Effect.logInfo("Setting up kernel manager").pipe(
      Effect.annotateLogs({ component: "kernel-manager" }),
    );
    const marimo = yield* LanguageClient;
    const renderer = yield* NotebookRenderer;
    const controllers = yield* NotebookControllers;

    const contexts = new Map<
      string,
      Omit<ops.OperationContext, "controller" | "renderer">
    >();

    const runFork = yield* FiberSet.makeRuntime<NotebookRenderer>();

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

          const controller = yield* controllers.getActiveController(
            context.notebook,
          );
          assert(
            Option.isSome(controller),
            `Expected notebook controller for ${notebookUri}`,
          );

          return yield* ops
            .routeOperation(
              { ...context, controller: controller.value },
              operation,
            )
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
