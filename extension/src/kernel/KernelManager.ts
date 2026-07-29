import {
  Data,
  Effect,
  Option,
  Queue,
  Runtime,
  Stream,
  Array as EffectArray,
} from "effect";

import { unreachable } from "../assert.ts";
import { Config } from "../config/Config.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
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
import {
  ControllerRegistry,
  resolveControllerExecutable,
} from "./ControllerRegistry.ts";
import { ExecutionRegistry } from "./ExecutionRegistry.ts";
import { resolveImageDataUri, saveImageToDisk } from "./imageResolver.ts";
import { handleMissingPackageAlert } from "./operations.ts";
import { type MarimoOperation, RuntimeSessions } from "./RuntimeSessions.ts";

/** An error returned when code is run for a notebook that has no kernel selected. */
export class NoActiveKernelError extends Data.TaggedError(
  "NoActiveKernelError",
)<{ readonly notebookUri: NotebookId }> {}

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
      RuntimeSessions.Default,
    ],
    scoped: Effect.gen(function* () {
      yield* Effect.logDebug("Setting up kernel manager");
      const code = yield* VsCode;
      const renderer = yield* NotebookRenderer;
      const controllers = yield* ControllerRegistry;
      const runtimeSessions = yield* RuntimeSessions;

      const queue = yield* Queue.unbounded<MarimoOperation>();

      yield* Effect.forkScoped(
        runtimeSessions
          .operations()
          .pipe(Stream.runForEach((msg) => Queue.offer(queue, msg))),
      );

      yield* Effect.forkScoped(
        Effect.gen(function* () {
          while (true) {
            const msg = yield* Queue.take(queue);
            yield* processOperation(msg).pipe(
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
                  const session = yield* runtimeSessions.getOrCreate(
                    notebook.id,
                  );
                  yield* session.updateUIElements(message.params);
                  return;
                }
                case "invoke-function": {
                  const session = yield* runtimeSessions.getOrCreate(
                    notebook.id,
                  );
                  yield* session.invokeFunction(message.params);
                  return;
                }
                case "set-model-value": {
                  const session = yield* runtimeSessions.getOrCreate(
                    notebook.id,
                  );
                  yield* session.updateModel(message.params);
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
        executeCodeUnsafe(notebookUri: NotebookId, sourceCode: string) {
          return Stream.unwrap(
            Effect.gen(function* () {
              // No selected kernel means no executable to start a session with,
              // so fail before sending code that can never run.
              const notebooks = yield* code.workspace.getNotebookDocuments();
              const notebook = EffectArray.findFirst(
                EffectArray.getSomes(
                  notebooks.map((raw) => MarimoNotebookDocument.tryFrom(raw)),
                ),
                (nb) => nb.id === notebookUri,
              );
              if (Option.isNone(notebook)) {
                return yield* new NoActiveKernelError({ notebookUri });
              }
              const controller = yield* controllers.getActiveController(
                notebook.value,
              );
              if (Option.isNone(controller)) {
                return yield* new NoActiveKernelError({ notebookUri });
              }
              const executable = yield* resolveControllerExecutable(
                controller.value,
                notebook.value,
              );

              const session = yield* runtimeSessions.getOrCreate(notebookUri);
              return session.executeScratchpad(sourceCode, executable);
            }),
          );
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

function processOperation({ notebookUri, operation }: MarimoOperation) {
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
      case "active-line":
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
      case "completed-run": {
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
        yield* processSessionOperation(notebookUri, operation);
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
        const cellId = extractCellIdFromCellMessage(operation);

        if (cellId === SCRATCH_CELL_ID) {
          // The scratch cell isn't a real notebook cell.
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
    const runtimeSessions = yield* RuntimeSessions;
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
        const session = yield* runtimeSessions.getOrCreate(notebookUri);
        yield* session.sendStdin({ text: result.value });
      } else {
        // User cancelled — interrupt the kernel so it stops waiting for input
        const session = yield* runtimeSessions.getOrCreate(notebookUri);
        yield* session.interrupt();
      }
    }
  });
}
