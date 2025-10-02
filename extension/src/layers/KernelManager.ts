import { Effect, FiberSet, Layer, Option, Queue } from "effect";
import { assert, unreachable } from "../assert.ts";
import * as ops from "../operations.ts";
import { Config } from "../services/Config.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookControllers } from "../services/NotebookControllers.ts";
import { NotebookRenderer } from "../services/NotebookRenderer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import { Uv } from "../services/Uv.ts";
import { VsCode } from "../services/VsCode.ts";
import {
  getNotebookUri,
  type MessageOperation,
  type NotebookUri,
} from "../types.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";

interface MarimoOperation {
  notebookUri: NotebookUri;
  operation: MessageOperation;
}

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
    yield* Effect.logInfo("Setting up kernel manager");
    const uv = yield* Uv;
    const code = yield* VsCode;
    const config = yield* Config;
    const marimo = yield* LanguageClient;
    const channel = yield* OutputChannel;
    const renderer = yield* NotebookRenderer;
    const controllers = yield* NotebookControllers;

    const runPromise = yield* FiberSet.makeRuntimePromise();

    const contexts = new Map<string, ops.OperationContext>();

    const queue = yield* Queue.unbounded<MarimoOperation>();
    yield* marimo.onNotification("marimo/operation", (msg) =>
      runPromise(
        Effect.gen(function* () {
          yield* Effect.logTrace("Recieved marimo/operation").pipe(
            Effect.annotateLogs({
              notebookUri: msg.notebookUri,
              op: msg.operation.op,
            }),
          );
          yield* Queue.offer(queue, msg);
        }),
      ),
    );

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const { notebookUri, operation } = yield* Queue.take(queue);
          yield* Effect.logDebug("Processing operation from queue").pipe(
            Effect.annotateLogs({ op: operation.op }),
          );
          yield* Effect.logTrace(operation.op, operation);
          let context = contexts.get(notebookUri);

          if (!context) {
            const editor = code.window
              .getVisibleNotebookEditors()
              .find((editor) => editor.notebook.uri.toString() === notebookUri);
            assert(editor, `Expected notebook document for ${notebookUri}`);
            context = { editor, executions: new Map() };
            contexts.set(notebookUri, context);
            yield* Effect.logInfo("Created new context for notebook").pipe(
              Effect.annotateLogs({ notebookUri }),
            );
          }

          const controller = yield* controllers.getActiveController(
            context.editor.notebook,
          );

          assert(
            Option.isSome(controller),
            `Expected notebook controller for ${notebookUri}`,
          );

          yield* ops.routeOperation(operation, {
            controller: controller.value,
            context,
            code,
            renderer,
            uv,
            runPromise,
            config,
          });

          yield* Effect.logDebug("Completed processing operation").pipe(
            Effect.annotateLogs({ op: operation.op }),
          );
        }
      }).pipe(
        Effect.catchAllCause(
          Effect.fnUntraced(function* (cause) {
            yield* Effect.logError(
              `Failed to process marimo operation.`,
              cause,
            );
            yield* showErrorAndPromptLogs(
              "Failed to process marimo operation.",
              { code, channel },
            );
          }),
        ),
      ),
    );

    // renderer (i.e., front end) -> kernel
    yield* renderer.onDidReceiveMessage(({ editor, message }) =>
      runPromise(
        Effect.gen(function* () {
          const notebookUri = getNotebookUri(editor.notebook);
          yield* Effect.logTrace("Renderer command").pipe(
            Effect.annotateLogs({ command: message.command, notebookUri }),
          );
          switch (message.command) {
            case "marimo.set_ui_element_value": {
              yield* marimo.setUiElementValue({
                notebookUri,
                inner: message.params,
              });
              return;
            }
            case "marimo.function_call_request": {
              yield* marimo.functionCallRequest({
                notebookUri,
                inner: message.params,
              });
              return;
            }
            default: {
              unreachable(message, "Unknown message from frontend");
            }
          }
        }),
      ),
    );

    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        yield* Effect.logInfo("Tearing down kernel manager");
        contexts.clear();
      }),
    );

    yield* Effect.logInfo("Kernel manager initialized");
  }),
);
