import { Effect, FiberSet, HashMap, Layer, Option, Queue, Ref } from "effect";
import type * as vscode from "vscode";
import { assert, unreachable } from "../assert.ts";
import { routeOperation } from "../operations.ts";
import { Config } from "../services/Config.ts";
import { ExecutionRegistry } from "../services/ExecutionRegistry.ts";
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
    const executions = yield* ExecutionRegistry;
    const controllers = yield* NotebookControllers;

    const runPromise = yield* FiberSet.makeRuntimePromise();

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

    const editorsRef = yield* Ref.make(
      HashMap.empty<NotebookUri, vscode.NotebookEditor>(),
    );

    yield* Effect.forkScoped(
      Effect.gen(function* () {
        while (true) {
          const { notebookUri, operation } = yield* Queue.take(queue);
          yield* Effect.logDebug("Processing operation from queue").pipe(
            Effect.annotateLogs({ op: operation.op }),
          );
          yield* Effect.logTrace(operation.op, operation);

          const editor = yield* Ref.modify(editorsRef, (map) => {
            const existing = HashMap.get(map, notebookUri);
            if (Option.isSome(existing)) {
              return [existing.value, map];
            }
            const editor = code.window
              .getVisibleNotebookEditors()
              .find((editor) => editor.notebook.uri.toString() === notebookUri);
            assert(editor, `Expected notebook document for ${notebookUri}`);
            return [editor, HashMap.set(map, notebookUri, editor)];
          });

          const controller = yield* controllers.getActiveController(
            editor.notebook,
          );
          assert(
            Option.isSome(controller),
            `Expected notebook controller for ${notebookUri}`,
          );

          yield* routeOperation(operation, {
            code,
            config,
            editor,
            executions,
            controller: controller.value,
            renderer,
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
  }),
);
