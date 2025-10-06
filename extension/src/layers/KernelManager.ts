import { Effect, FiberSet, Layer, Option, Queue, Stream } from "effect";
import { unreachable } from "../assert.ts";
import { routeOperation } from "../operations.ts";
import { Config } from "../services/Config.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
import { LanguageClient } from "../services/LanguageClient.ts";
import { NotebookEditorRegistry } from "../services/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../services/NotebookRenderer.ts";
import { OutputChannel } from "../services/OutputChannel.ts";
import { Uv } from "../services/Uv.ts";
import { VsCode } from "../services/VsCode.ts";
import { VariablesService } from "../services/variables/VariablesService.ts";
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
    const client = yield* LanguageClient;
    const channel = yield* OutputChannel;
    const editors = yield* NotebookEditorRegistry;
    const renderer = yield* NotebookRenderer;
    const executions = yield* ExecutionRegistry;
    const controllers = yield* ControllerRegistry;
    const variables = yield* VariablesService;

    const runPromise = yield* FiberSet.makeRuntimePromise();

    const queue = yield* Queue.unbounded<MarimoOperation>();

    yield* Effect.forkScoped(
      client.streamOf("marimo/operation").pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* (msg) {
            yield* Effect.logTrace("Recieved marimo/operation").pipe(
              Effect.annotateLogs({
                notebookUri: msg.notebookUri,
                op: msg.operation.op,
              }),
            );
            yield* Queue.offer(queue, msg);
          }),
        ),
        Stream.runDrain,
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

          const editor = Option.getOrThrowWith(
            yield* editors.getLastNotebookEditor(notebookUri),
            () => new Error(`Expected NotebookEditor for ${notebookUri}`),
          );
          const controller = Option.getOrThrowWith(
            yield* controllers.getActiveController(editor.notebook),
            () => new Error(`Expected NotebookController for ${notebookUri}`),
          );

          yield* routeOperation(operation, {
            code,
            config,
            executions,
            editor,
            notebookUri,
            controller,
            renderer,
            variables,
            runPromise,
            uv,
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
    yield* Effect.forkScoped(
      renderer.messages().pipe(
        Stream.mapEffect(
          Effect.fnUntraced(function* ({ editor, message }) {
            const notebookUri = getNotebookUri(editor.notebook);
            yield* Effect.logTrace("Renderer command").pipe(
              Effect.annotateLogs({ command: message.command, notebookUri }),
            );
            switch (message.command) {
              case "marimo.set_ui_element_value": {
                yield* client.executeCommand({
                  command: message.command,
                  params: {
                    notebookUri,
                    inner: message.params,
                  },
                });
                return;
              }
              case "marimo.function_call_request": {
                yield* client.executeCommand({
                  command: message.command,
                  params: {
                    notebookUri,
                    inner: message.params,
                  },
                });
                return;
              }
              default: {
                unreachable(message, "Unknown message from frontend");
              }
            }
          }),
        ),
        Stream.runDrain,
      ),
    );
  }),
);
