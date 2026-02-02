import {
  Deferred,
  Effect,
  Option,
  PubSub,
  Queue,
  Runtime,
  Stream,
} from "effect";
import { unreachable } from "../assert.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { handleMissingPackageAlert } from "../operations.ts";
import {
  extractCellIdFromCellMessage,
  MarimoNotebookDocument,
  type NotebookId,
} from "../schemas.ts";
import type { CellOperationNotification, Notification } from "../types.ts";
import { showErrorAndPromptLogs } from "../utils/showErrorAndPromptLogs.ts";
import { Config } from "./Config.ts";
import { Constants } from "./Constants.ts";
import { ControllerRegistry } from "./ControllerRegistry.ts";
import { TyLanguageServer } from "./completions/TyLanguageServer.ts";
import { DatasourcesService } from "./datasources/DatasourcesService.ts";
import { ExecutionRegistry } from "./ExecutionRegistry.ts";
import { LanguageClient } from "./LanguageClient.ts";
import { NotebookEditorRegistry } from "./NotebookEditorRegistry.ts";
import { NotebookRenderer } from "./NotebookRenderer.ts";
import { OutputChannel } from "./OutputChannel.ts";
import { Uv } from "./Uv.ts";
import { VsCode } from "./VsCode.ts";
import { VariablesService } from "./variables/VariablesService.ts";

interface MarimoOperation {
  notebookUri: NotebookId;
  operation: Notification;
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
      TyLanguageServer.Default,
      NotebookRenderer.Default,
      ExecutionRegistry.Default,
      DatasourcesService.Default,
      NotebookEditorRegistry.Default,
    ],
    scoped: Effect.gen(function* () {
      yield* Effect.logInfo("Setting up kernel manager");
      const code = yield* VsCode;
      const client = yield* LanguageClient;
      const renderer = yield* NotebookRenderer;

      const runPromise = Runtime.runPromise(yield* Effect.runtime());
      const queue = yield* Queue.unbounded<MarimoOperation>();

      // PubSub for scratch cell operations
      const scratchOps = yield* PubSub.unbounded<CellOperationNotification>();

      // Semaphore to serialize concurrent scratchpad executions
      const scratchLock = yield* Effect.makeSemaphore(1);

      yield* Effect.forkScoped(
        client.streamOf("marimo/operation").pipe(
          Stream.mapEffect(
            Effect.fnUntraced(function* (msg) {
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
            yield* processOperation(msg, runPromise, scratchOps).pipe(
              Effect.annotateLogs({
                notebookUri: msg.notebookUri,
                operation: msg.operation.op,
              }),
              Effect.withSpan("process-operation"),
              Effect.catchAllCause(
                Effect.fnUntraced(function* (cause) {
                  yield* Effect.logError(
                    "Failed to process marimo operation",
                    cause,
                  );
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
          Stream.mapEffect(
            Effect.fnUntraced(function* ({ editor, message }) {
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
                case "navigate-to-cell": {
                  const { cellId } = message.params;
                  const editor = yield* code.window.getActiveNotebookEditor();

                  if (Option.isNone(editor)) {
                    return yield* Effect.logWarning(
                      "No active notebook editor to navigate to cell",
                    );
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
                default: {
                  unreachable(message, "Unknown message from frontend");
                }
              }
            }),
          ),
          Stream.runDrain,
        ),
      );

      return {
        /**
         * Execute code in the scratchpad (isolated from dependency graph).
         * Returns a stream of cell operations that completes 50ms after idle.
         */
        executeCodeUnsafe(notebookUri: NotebookId, code: string) {
          return Effect.gen(function* () {
            // 1. Subscribe BEFORE sending command (avoid race)
            const sub = yield* PubSub.subscribe(scratchOps);

            // 2. Send command to kernel
            yield* client.executeCommand({
              command: "marimo.api",
              params: {
                method: "execute-scratchpad",
                params: { notebookUri, inner: { code } },
              },
            });

            // 3. Stream cell-ops until idle, then wait 50ms for trailing output
            // marimo flushes stdio every 10ms, so we need to collect trailing messages
            const sawIdle = yield* Deferred.make<void>();
            return Stream.fromQueue(sub).pipe(
              Stream.tap((op) =>
                op.status === "idle"
                  ? Deferred.succeed(sawIdle, void 0)
                  : Effect.void,
              ),
              // Complete 50ms after idle
              Stream.interruptWhen(
                Deferred.await(sawIdle).pipe(
                  Effect.zipRight(Effect.sleep("50 millis")),
                ),
              ),
            );
          }).pipe(scratchLock.withPermits(1), Stream.unwrapScoped);
        },
      };
    }),
  },
) {}

function processOperation(
  { notebookUri, operation }: MarimoOperation,
  runPromise: <A, E>(effect: Effect.Effect<A, E, never>) => Promise<A>,
  scratchOps: PubSub.PubSub<CellOperationNotification>,
) {
  return Effect.gen(function* () {
    const uv = yield* Uv;
    const code = yield* VsCode;
    const config = yield* Config;
    const editors = yield* NotebookEditorRegistry;
    const renderer = yield* NotebookRenderer;
    const executions = yield* ExecutionRegistry;
    const controllers = yield* ControllerRegistry;
    const variables = yield* VariablesService;
    const datasources = yield* DatasourcesService;
    const tyLsp = yield* TyLanguageServer;

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

        // Route __scratch__ to PubSub, not ExecutionRegistry
        if (cellId === SCRATCH_CELL_ID) {
          yield* PubSub.publish(scratchOps, operation);
          break;
        }

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
          handleMissingPackageAlert(operation, notebook, controller).pipe(
            Effect.provideService(Uv, uv),
            Effect.provideService(VsCode, code),
            Effect.provideService(Config, config),
            Effect.provideService(TyLanguageServer, tyLsp),
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
        yield* Effect.logWarning("Unknown operation");
        break;
      }
    }
  });
}
