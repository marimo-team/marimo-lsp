import { Effect, Layer, Option, Queue, Runtime, Stream } from "effect";
import { unreachable } from "../assert.ts";
import { handleMissingPackageAlert } from "../operations.ts";
import { Config } from "../services/Config.ts";
import { ControllerRegistry } from "../services/ControllerRegistry.ts";
import { DatasourcesService } from "../services/datasources/DatasourcesService.ts";
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
    const datasources = yield* DatasourcesService;

    const runPromise = Runtime.runPromise(yield* Effect.runtime());
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
          const msg = yield* Queue.take(queue);
          yield* Effect.logDebug("Processing operation from queue").pipe(
            Effect.annotateLogs({ op: msg.operation.op }),
          );
          yield* Effect.logTrace(msg.operation.op, msg.operation);

          yield* processOperation(msg, {
            editors,
            controllers,
            executions,
            variables,
            datasources,
            renderer,
            runPromise,
            uv,
            code,
            config,
          }).pipe(
            Effect.catchAllCause(
              Effect.fnUntraced(function* (cause) {
                const errorMessage = "Failed to process marimo operation.";
                yield* Effect.logError(errorMessage, cause).pipe(
                  Effect.annotateLogs({ op: msg.operation.op }),
                );
                yield* Effect.fork(
                  showErrorAndPromptLogs(errorMessage, { code, channel }),
                );
              }),
            ),
          );
        }
      }),
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
              case "set_ui_element_value": {
                yield* client.executeCommand({
                  command: "marimo.api",
                  params: {
                    method: message.command,
                    params: {
                      notebookUri,
                      inner: message.params,
                    },
                  },
                });
                return;
              }
              case "function_call_request": {
                yield* client.executeCommand({
                  command: "marimo.api",
                  params: {
                    method: message.command,
                    params: {
                      notebookUri,
                      inner: message.params,
                    },
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

function processOperation(
  { notebookUri, operation }: MarimoOperation,
  deps: {
    editors: NotebookEditorRegistry;
    controllers: ControllerRegistry;
    executions: ExecutionRegistry;
    variables: VariablesService;
    datasources: DatasourcesService;
    renderer: NotebookRenderer;
    runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>;
    uv: Uv;
    code: VsCode;
    config: Config;
  },
) {
  return Effect.gen(function* () {
    const {
      editors,
      controllers,
      executions,
      variables,
      datasources,
      renderer,
      runPromise,
      uv,
      code,
      config,
    } = deps;
    const editor = Option.getOrThrowWith(
      yield* editors.getLastNotebookEditor(notebookUri),
      () => new Error(`Expected NotebookEditor for ${notebookUri}`),
    );

    const maybeController = yield* controllers.getActiveController(
      editor.notebook,
    );

    if (Option.isNone(maybeController)) {
      yield* Effect.logWarning("No active controller, skipping operation").pipe(
        Effect.annotateLogs({ op: operation.op }),
      );
      return;
    }

    const controller = yield* maybeController;

    switch (operation.op) {
      case "cell-op": {
        yield* executions.handleCellOperation(operation, {
          editor,
          controller,
        });
        break;
      }
      case "interrupted": {
        yield* executions.handleInterrupted(editor);
        break;
      }
      case "completed-run": {
        break;
      }
      case "missing-package-alert": {
        // Handle in a separate fork (we don't want to block resolution)
        runPromise(
          handleMissingPackageAlert(
            operation,
            editor.notebook,
            controller,
          ).pipe(
            Effect.provideService(Uv, uv),
            Effect.provideService(VsCode, code),
            Effect.provideService(Config, config),
          ),
        );
        break;
      }
      // Update variable state
      case "variables": {
        yield* variables.updateVariables(notebookUri, operation);
        break;
      }
      case "variable-values": {
        yield* variables.updateVariableValues(notebookUri, operation);
        break;
      }
      // Update datasource state
      case "data-source-connections": {
        yield* datasources.updateConnections(notebookUri, operation);
        break;
      }
      case "datasets": {
        yield* datasources.updateDatasets(notebookUri, operation);
        break;
      }
      case "sql-table-preview": {
        yield* datasources.updateTablePreview(notebookUri, operation);
        break;
      }
      case "sql-table-list-preview": {
        yield* datasources.updateTableListPreview(notebookUri, operation);
        break;
      }
      case "data-column-preview": {
        yield* datasources.updateColumnPreview(notebookUri, operation);
        break;
      }
      // Forward to renderer (front end) (non-blocking)
      case "remove-ui-elements":
      case "function-call-result":
      case "send-ui-element-message": {
        runPromise(renderer.postMessage(operation, editor));
        break;
      }
      case "update-cell-codes":
      case "focus-cell": {
        // Ignore
        break;
      }
      default: {
        yield* Effect.logWarning("Unknown operation").pipe(
          Effect.annotateLogs({ op: operation.op }),
        );
        break;
      }
    }

    yield* Effect.logDebug("Completed processing operation").pipe(
      Effect.annotateLogs({ op: operation.op }),
    );
  });
}
