import {
  Effect,
  Option,
  PubSub,
  Queue,
  Runtime,
  Stream,
  Array as EffectArray,
} from "effect";

import { unreachable } from "../assert.ts";
import { Config } from "../config/Config.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import { LanguageClient } from "../lsp/LanguageClient.ts";
import { applyDocumentTransaction } from "../notebook/applyDocumentTransaction.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../notebook/NotebookRenderer.ts";
import { DatasourcesService } from "../panel/datasources/DatasourcesService.ts";
import { VariablesService } from "../panel/variables/VariablesService.ts";
import { Constants } from "../platform/Constants.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { VsCode } from "../platform/VsCode.ts";
import { PythonEnvInvalidation } from "../python/PythonEnvInvalidation.ts";
import { Uv } from "../python/Uv.ts";
import { MarimoNotebookDocument } from "../schemas/MarimoNotebookDocument.ts";
import {
  extractCellIdFromCellMessage,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  Notification,
  NotificationOf,
} from "../types.ts";
import { ControllerRegistry } from "./ControllerRegistry.ts";
import { ExecutionRegistry } from "./ExecutionRegistry.ts";
import { resolveImageDataUri, saveImageToDisk } from "./imageResolver.ts";
import { handleMissingPackageAlert } from "./operations.ts";

interface MarimoOperation {
  notebookUri: NotebookId;
  operation: Notification;
}

type ScratchEvent =
  | CellOperationNotification
  | NotificationOf<"completed-run">;

function hasRunId<T extends { run_id?: string | null }>(
  event: T,
): event is T & { run_id: string } {
  return typeof event.run_id === "string" && event.run_id.length > 0;
}

function isCompletedRunFor(runId: string) {
  return (
    event: ScratchEvent,
  ): event is NotificationOf<"completed-run"> & { run_id: string } =>
    event.op === "completed-run" && hasRunId(event) && event.run_id === runId;
}

function isCellOpFor(runId: string) {
  return (
    event: ScratchEvent,
  ): event is CellOperationNotification & { run_id: string } =>
    event.op === "cell-op" && hasRunId(event) && event.run_id === runId;
}

/**
 * Orchestrates kernel operations for marimo notebooks by composing
 * MarimoLanguageClient, MarimoNotebookRenderer, and MarimoNotebookControllers.
 *
 * Receives `marimo/operations` from marimo-lsp and prepares cell executions.
 *
 * Receives messages from front end (renderer), and sends back to kernel.
 */
export class KernelManager extends Effect.Service<KernelManager>()(
  "KernelManager",
  {
    dependencies: [
      Uv.Default,
      Config.Default,
      Constants.Default,
      OutputChannel.Default,
      VariablesService.Default,
      NotebookRenderer.Default,
      ExecutionRegistry.Default,
      DatasourcesService.Default,
      NotebookEditorRegistry.Default,
      PythonEnvInvalidation.Default,
    ],
    scoped: Effect.gen(function* () {
      yield* Effect.logDebug("Setting up kernel manager");
      const code = yield* VsCode;
      const client = yield* LanguageClient;
      const renderer = yield* NotebookRenderer;

      const queue = yield* Queue.unbounded<MarimoOperation>();

      // PubSub for scratch cell operations + the completed-run that ends them.
      // A scratchpad's `completed-run` echoes the command's `runId`, so a
      // consumer waits for *its* completion — including any code-mode cascade —
      // rather than the scratch cell merely going idle.
      const scratchOps = yield* PubSub.unbounded<
        ScratchEvent
      >();

      // Semaphore to serialize concurrent scratchpad executions
      const scratchLock = yield* Effect.makeSemaphore(1);

      yield* Effect.forkScoped(
        client
          .streamOf("marimo/operation")
          .pipe(Stream.runForEach((msg) => Queue.offer(queue, msg))),
      );

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            const msg = yield* Queue.take(queue);
            yield* processOperation(msg, scratchOps).pipe(
              Effect.annotateLogs({
                notebookUri: msg.notebookUri,
                operation: msg.operation.op,
              }),
              Effect.withSpan("process-operation"),
              Effect.catchAllCause(
                Effect.fn(function* (cause) {
                  yield* Effect.logError(
                    "Failed to process marimo operation",
                  ).pipe(Effect.annotateLogs({ cause }));
                  yield* Effect.fork(
                    showErrorAndPromptLogs(
                      "Failed to process marimo operation.",
                    ),
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
          Stream.runForEach(
            Effect.fn(function* ({ editor, message }) {
              const notebook = MarimoNotebookDocument.from(editor.notebook);
              switch (message.command) {
                case "update-ui-element": {
                  yield* client.executeCommand({
                    command: "marimo.api",
                    params: {
                      method: message.command,
                      params: {
                        notebookUri: notebook.id,
                        inner: message.params,
                      },
                    },
                  });
                  return;
                }
                case "invoke-function": {
                  yield* client.executeCommand({
                    command: "marimo.api",
                    params: {
                      method: message.command,
                      params: {
                        notebookUri: notebook.id,
                        inner: message.params,
                      },
                    },
                  });
                  return;
                }
                case "set-model-value": {
                  yield* client.executeCommand({
                    command: "marimo.api",
                    params: {
                      method: message.command,
                      params: {
                        notebookUri: notebook.id,
                        inner: message.params,
                      },
                    },
                  });
                  return;
                }
                case "navigate-to-cell": {
                  const { cellId } = message.params;
                  const editor = yield* code.window.getActiveNotebookEditor();

                  if (Option.isNone(editor)) {
                    yield* Effect.logWarning(
                      "No active notebook editor to navigate to cell",
                    );
                    return;
                  }

                  const cellIndex = MarimoNotebookDocument.from(
                    editor.value.notebook,
                  )
                    .getCells()
                    .findIndex((cell) =>
                      Option.match(cell.id, {
                        onSome: (id) => id === cellId,
                        onNone: () => false,
                      }),
                    );

                  if (cellIndex !== -1) {
                    editor.value.revealRange(
                      new code.NotebookRange(cellIndex, cellIndex + 1),
                      code.NotebookEditorRevealType.InCenter,
                    );
                  }
                  return;
                }
                case "save-image": {
                  yield* saveImageToDisk(
                    message.params.src,
                    message.params.suggestedName,
                    editor.notebook.uri,
                  ).pipe(
                    Effect.catchAll((cause) =>
                      Effect.logError("Failed to save image").pipe(
                        Effect.annotateLogs({ cause }),
                      ),
                    ),
                  );
                  return;
                }
                case "copy-image": {
                  const { src, requestId } = message.params;
                  const dataUri = yield* resolveImageDataUri(src).pipe(
                    Effect.option,
                  );
                  yield* renderer.postMessage(
                    {
                      op: "image-data-result",
                      requestId,
                      dataUri: Option.getOrNull(dataUri),
                    },
                    editor,
                  );
                  return;
                }
                default: {
                  unreachable(message, "Unknown message from frontend");
                }
              }
            }),
          ),
        ),
      );

      return {
        /**
         * Execute code in the scratchpad (isolated from dependency graph).
         * Returns a stream of cell operations that completes once the
         * scratchpad's `completed-run` arrives — i.e. after any code-mode
         * cascade has settled, not merely when the scratch cell goes idle.
         */
        executeCodeUnsafe(notebookUri: NotebookId, code: string) {
          return Effect.gen(function* () {
            // 1. Subscribe BEFORE sending command (avoid race)
            const sub = yield* PubSub.subscribe(scratchOps);

            // 2. Send command to kernel, tagged with a runId the kernel echoes
            //    back on the terminating completed-run.
            const runId = crypto.randomUUID();
            yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "execute-scratchpad",
                params: { notebookUri, inner: { code, runId } },
              },
            });

            // 3. Stream cell-ops until *our* completed-run. takeUntil is
            //    inclusive, so filter the sentinel back out of the output.
            return Stream.fromQueue(sub).pipe(
              Stream.takeUntil(isCompletedRunFor(runId)),
              Stream.filter(isCellOpFor(runId)),
            );
          }).pipe(scratchLock.withPermits(1), Stream.unwrapScoped);
        },
      };
    }),
  },
) {}

function isValueUpdateEcho(
  operation: NotificationOf<"send-ui-element-message">,
): boolean {
  const message = operation.message;
  return (
    typeof message === "object" &&
    message !== null &&
    message.type === "marimo-ui-value-update"
  );
}

function processOperation(
  { notebookUri, operation }: MarimoOperation,
  scratchOps: PubSub.PubSub<ScratchEvent>,
) {
  return Effect.gen(function* () {
    const variables = yield* VariablesService;
    const datasources = yield* DatasourcesService;

    switch (operation.op) {
      // These operations don't require an active editor or controller
      case "variables": {
        yield* variables.updateVariables(notebookUri, operation);
        break;
      }
      case "variable-values": {
        yield* variables.updateVariableValues(notebookUri, operation);
        break;
      }
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
      // Ignored — not relevant in VS Code context
      case "alert":
      case "banner":
      case "cache-cleared":
      case "cache-info":
      case "completion-result":
      case "consumer-capabilities":
      case "focus-cell":
      case "installing-package-alert":
      case "kernel-ready":
      case "kernel-startup-error":
      case "query-params-append":
      case "query-params-clear":
      case "query-params-delete":
      case "query-params-set":
      case "reconnected":
      case "reload":
      case "secret-keys-result":
      case "sql-schema-list-preview":
      case "startup-logs":
      case "storage-download-ready":
      case "storage-entries":
      case "storage-namespaces":
      case "validate-sql-result": {
        break;
      }
      // Ends a scratchpad stream (matched by runId). Published unconditionally;
      // dropped when no scratchpad execution is subscribed.
      case "completed-run": {
        yield* PubSub.publish(scratchOps, operation);
        break;
      }
      // Replay kernel-originated document edits onto the VS Code notebook.
      case "notebook-document-transaction": {
        yield* applyTransactionToEditor(notebookUri, operation);
        break;
      }
      // These operations require an active editor and controller
      case "cell-op":
      case "interrupted":
      case "missing-package-alert":
      case "remove-ui-elements":
      case "function-call-result":
      case "send-ui-element-message":
      case "model-lifecycle": {
        yield* processSessionOperation(notebookUri, operation, scratchOps);
        break;
      }
      default: {
        yield* Effect.logWarning("Unknown operation").pipe(
          Effect.annotateLogs({ op: (operation as Notification).op }),
        );
        unreachable(operation, "Unknown operation");
      }
    }
  });
}

/**
 * Handle operations that require an active notebook editor and controller.
 */
/**
 * Resolve the notebook editor for a kernel-originated document transaction and
 * replay it. Needs an editor (to address the document) but not a controller.
 */
function applyTransactionToEditor(
  notebookUri: NotebookId,
  operation: NotificationOf<"notebook-document-transaction">,
) {
  return Effect.gen(function* () {
    const editors = yield* NotebookEditorRegistry;
    const maybeEditor = yield* editors.getLastNotebookEditor(notebookUri);

    if (Option.isNone(maybeEditor)) {
      yield* Effect.logWarning(
        "No active notebook editor; dropping document transaction",
      );
      return;
    }

    const notebook = MarimoNotebookDocument.from(maybeEditor.value.notebook);
    yield* applyDocumentTransaction(notebook, operation.transaction);
  });
}

function processSessionOperation(
  notebookUri: NotebookId,
  operation:
    | CellOperationNotification
    | NotificationOf<"interrupted">
    | NotificationOf<"missing-package-alert">
    | NotificationOf<"remove-ui-elements">
    | NotificationOf<"function-call-result">
    | NotificationOf<"send-ui-element-message">
    | NotificationOf<"model-lifecycle">,
  scratchOps: PubSub.PubSub<ScratchEvent>,
) {
  return Effect.gen(function* () {
    const uv = yield* Uv;
    const code = yield* VsCode;
    const config = yield* Config;
    const editors = yield* NotebookEditorRegistry;
    const renderer = yield* NotebookRenderer;
    const executions = yield* ExecutionRegistry;
    const controllers = yield* ControllerRegistry;
    const envInvalidation = yield* PythonEnvInvalidation;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());

    const maybeEditor = yield* editors.getLastNotebookEditor(notebookUri);

    if (Option.isNone(maybeEditor)) {
      yield* Effect.logWarning("No active notebook editor, skipping operation");
      return;
    }

    const editor = Option.getOrThrow(maybeEditor);
    const notebook = MarimoNotebookDocument.from(editor.notebook);
    const maybeController = yield* controllers.getActiveController(notebook);

    if (Option.isNone(maybeController)) {
      yield* Effect.logWarning("No active controller, skipping operation");
      return;
    }

    const controller = yield* maybeController;

    switch (operation.op) {
      case "cell-op": {
        // Feed run-scoped cell-ops into the scratch stream so executeCode can
        // surface downstream stdout/stderr/errors from code-mode cascades.
        if (hasRunId(operation)) {
          yield* PubSub.publish(scratchOps, operation);
        }

        const cellId = extractCellIdFromCellMessage(operation);

        // Route __scratch__ to PubSub, not ExecutionRegistry
        if (cellId === SCRATCH_CELL_ID) {
          break;
        }

        yield* executions.handleCellOperation(operation, {
          editor,
          controller,
        });

        // If the operation contains a stdin console message, prompt for input
        // Fork so we don't block the operation processing loop
        yield* Effect.fork(handleStdinPrompt(operation, notebookUri));
        break;
      }
      case "interrupted": {
        yield* executions.handleInterrupted(editor);
        break;
      }
      case "missing-package-alert": {
        // Handle in a separate fork (we don't want to block resolution)
        void runPromise(
          handleMissingPackageAlert(operation, notebook, controller).pipe(
            Effect.provideService(Uv, uv),
            Effect.provideService(VsCode, code),
            Effect.provideService(Config, config),
            Effect.provideService(PythonEnvInvalidation, envInvalidation),
          ),
        );
        break;
      }
      // Forward to renderer (front end) (non-blocking)
      case "remove-ui-elements":
      case "function-call-result":
      case "model-lifecycle": {
        void runPromise(renderer.postMessage(operation, editor));
        break;
      }
      case "send-ui-element-message": {
        // Drop `marimo-ui-value-update` echoes. The kernel broadcasts
        // them for every UI value change, but over the LSP transport
        // they arrive ~one round-trip stale and clobber the user's
        // in-progress state (visible slider snap). Marimo-lsp doesn't
        // yet surface code_mode, which is the only path that
        // genuinely needs these echoes, so dropping them entirely is
        // safe. Upstream (marimo-team/marimo) is gating this broadcast
        // behind a `notify_frontend` flag; once released, this guard
        // can be removed. Non-value-update widget messages
        // (anywidget comms, custom plugin messages) still forward.
        // See issue #515.
        if (isValueUpdateEcho(operation)) {
          break;
        }
        void runPromise(renderer.postMessage(operation, editor));
        break;
      }
      default: {
        unreachable(operation, "Unknown session operation");
      }
    }
  });
}

/**
 * Detects stdin console messages in a cell-op and prompts the user for input.
 * Sends the response back to the kernel via the `send-stdin` API method.
 */
function handleStdinPrompt(
  operation: CellOperationNotification,
  notebookUri: NotebookId,
) {
  return Effect.gen(function* () {
    const code = yield* VsCode;
    const client = yield* LanguageClient;
    if (operation.console == null) {
      return;
    }

    const consoleOutputs = EffectArray.ensure(operation.console);
    for (const output of consoleOutputs) {
      if (output.channel !== "stdin") {
        continue;
      }

      const prompt = typeof output.data === "string" ? output.data : "";

      const result = yield* code.window.showInputBox({
        prompt: prompt || "input()",
        password: output.mimetype === "text/password",
      });

      if (Option.isSome(result)) {
        yield* client.executeCommand({
          command: "marimo.api",
          params: {
            method: "send-stdin",
            params: {
              notebookUri,
              inner: { text: result.value },
            },
          },
        });
      } else {
        // User cancelled — interrupt the kernel so it stops waiting for input
        yield* client.executeCommand({
          command: "marimo.api",
          params: {
            method: "interrupt",
            params: {
              notebookUri,
              inner: {},
            },
          },
        });
      }
    }
  });
}
