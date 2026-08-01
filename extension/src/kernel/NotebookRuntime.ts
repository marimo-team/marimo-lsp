import {
  Chunk,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  type ParseResult,
  PubSub,
  Queue,
  Ref,
  Runtime,
  Stream,
  TSemaphore,
  Array as EffectArray,
} from "effect";
import type * as vscode from "vscode";

import { unreachable } from "../assert.ts";
import { Config } from "../config/Config.ts";
import { SCRATCH_CELL_ID } from "../constants.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import {
  MarimoClient,
  type MarimoClientStartError,
  type MarimoCommandError,
} from "../lsp/MarimoClient.ts";
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
import {
  extractCellIdFromCellMessage,
  MarimoNotebookCell,
  MarimoNotebookDocument,
  type NotebookCellId,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  MarimoOperation,
  NotificationOf,
} from "../types.ts";
import { CellExecutions } from "./CellExecutions.ts";
import { resolveImageDataUri, saveImageToDisk } from "./imageResolver.ts";
import { handleMissingPackageAlert } from "./operations.ts";

type InnerRequest<K extends keyof MarimoClient> = MarimoClient[K] extends (
  params: infer Params,
) => unknown
  ? Params extends { readonly inner: infer Request }
    ? Request
    : never
  : never;

export interface NotebookController {
  readonly id: string;
  readonly executable?: string;
  readonly createNotebookCellExecution: (
    cell: MarimoNotebookCell,
  ) => vscode.NotebookCellExecution;
  readonly resolveExecutable: (
    notebook: MarimoNotebookDocument,
  ) => Effect.Effect<string, ExecutableResolutionError | UnsavedNotebookError>;
}

export interface NotebookControllerSelection {
  readonly notebookUri: NotebookId;
  readonly controller: NotebookController;
}

/** No controller is selected for the notebook. */
export class NoActiveKernelError extends Data.TaggedError(
  "NoActiveKernelError",
)<{ readonly notebookUri: NotebookId }> {}

/** A controller could not resolve a Python executable for the notebook. */
export class ExecutableResolutionError extends Data.TaggedError(
  "ExecutableResolutionError",
)<{ readonly notebookUri: NotebookId; readonly cause: unknown }> {}

/** A sandbox controller needs a saved notebook to resolve its environment. */
export class UnsavedNotebookError extends Data.TaggedError(
  "UnsavedNotebookError",
)<{ readonly notebookUri: NotebookId }> {}

/**
 * Commands and scratchpad execution for one notebook.
 *
 * The notebook ID is captured by the handle instead of repeated at every
 * call site.
 */
export interface NotebookHandle {
  readonly id: NotebookId;
  readonly getController: () => Effect.Effect<
    Option.Option<NotebookController>
  >;
  readonly executeCells: (
    request: InnerRequest<"executeCells">,
    executable: string,
  ) => ReturnType<MarimoClient["executeCells"]>;
  readonly executeScratchpad: (
    code: string,
  ) => Stream.Stream<
    CellOperationNotification,
    | ExecutableResolutionError
    | MarimoClientStartError
    | MarimoCommandError
    | NoActiveKernelError
    | ParseResult.ParseError
    | UnsavedNotebookError
  >;
  readonly updateUIElements: (
    request: InnerRequest<"updateUiElement">,
  ) => ReturnType<MarimoClient["updateUiElement"]>;
  readonly updateModel: (
    request: InnerRequest<"setModelValue">,
  ) => ReturnType<MarimoClient["setModelValue"]>;
  readonly invokeFunction: (
    request: InnerRequest<"invokeFunction">,
  ) => ReturnType<MarimoClient["invokeFunction"]>;
  readonly deleteCell: (
    request: InnerRequest<"deleteCell">,
  ) => ReturnType<MarimoClient["deleteCell"]>;
  readonly sendStdin: (
    request: InnerRequest<"sendStdin">,
  ) => ReturnType<MarimoClient["sendStdin"]>;
  readonly interrupt: () => ReturnType<MarimoClient["interrupt"]>;
  readonly close: () => ReturnType<MarimoClient["closeSession"]>;
}

interface NotebookState {
  readonly handle: NotebookHandle;
  readonly controller: Ref.Ref<Option.Option<NotebookController>>;
}

function hasRunId<T extends { run_id?: string | null }>(
  event: T,
): event is T & { run_id: string } {
  return typeof event.run_id === "string" && event.run_id.length > 0;
}

function isCompletedRunFor(runId: string) {
  return (message: MarimoOperation) =>
    message.operation.op === "completed-run" &&
    hasRunId(message.operation) &&
    message.operation.run_id === runId;
}

function isScratchpadOutput(
  operation: MarimoOperation["operation"],
): operation is CellOperationNotification {
  if (operation.op !== "cell-op") return false;
  if (operation.cell_id === SCRATCH_CELL_ID) return true;
  if (operation.console == null) return false;
  return EffectArray.ensure(operation.console).some(
    (output) => output.channel === "stdout" || output.channel === "stderr",
  );
}

/**
 * Owns notebook handles, controller selection, and kernel message handling.
 *
 * ```ts
 * const runtime = yield* NotebookRuntime;
 * const notebook = runtime.forNotebook(notebookId);
 *
 * yield* notebook.executeCells(request, executable);
 * yield* notebook.updateUIElements(update);
 * yield* notebook.interrupt();
 * ```
 *
 * Commands still go directly through MarimoClient. This Module does not
 * schedule or merge them.
 */
export class NotebookRuntime extends Effect.Service<NotebookRuntime>()(
  "NotebookRuntime",
  {
    dependencies: [
      Uv.Default,
      Config.Default,
      Constants.Default,
      OutputChannel.Default,
      VariablesService.Default,
      NotebookRenderer.Default,
      CellExecutions.Default,
      DatasourcesService.Default,
      NotebookEditorRegistry.Default,
      PythonEnvInvalidation.Default,
    ],
    scoped: Effect.gen(function* () {
      const code = yield* VsCode;
      const marimo = yield* MarimoClient;
      const renderer = yield* NotebookRenderer;
      const executions = yield* CellExecutions;
      const operations = yield* PubSub.unbounded<MarimoOperation>();
      const notebooks = new Map<NotebookId, NotebookState>();
      const controllerSelections =
        yield* PubSub.unbounded<NotebookControllerSelection>();

      yield* Effect.addFinalizer(() =>
        Effect.all(
          [PubSub.shutdown(operations), PubSub.shutdown(controllerSelections)],
          { discard: true },
        ),
      );

      const makeHandle = (
        notebookId: NotebookId,
        controller: Ref.Ref<Option.Option<NotebookController>>,
        scratchpadLock: TSemaphore.TSemaphore,
      ): NotebookHandle => ({
        id: notebookId,
        getController: () => Ref.get(controller),
        executeCells: (request, executable) =>
          marimo.executeCells({
            notebookUri: notebookId,
            executable,
            inner: request,
          }),
        executeScratchpad: (sourceCode) =>
          Stream.unwrapScoped(
            Effect.gen(function* () {
              yield* TSemaphore.withPermitsScoped(scratchpadLock, 1);

              const selectedController = yield* Ref.get(controller);
              if (Option.isNone(selectedController)) {
                return yield* new NoActiveKernelError({
                  notebookUri: notebookId,
                });
              }

              const notebook = yield* findOpenNotebook(notebookId);
              const executable =
                yield* selectedController.value.resolveExecutable(notebook);
              const subscription = yield* PubSub.subscribe(operations);
              const runId = crypto.randomUUID();

              yield* marimo.executeScratchpad({
                notebookUri: notebookId,
                executable,
                inner: { code: sourceCode, runId },
              });

              yield* Effect.addFinalizer((exit) =>
                Exit.isInterrupted(exit)
                  ? marimo
                      .interrupt({ notebookUri: notebookId, inner: {} })
                      .pipe(
                        Effect.catchAllCause((cause) =>
                          Effect.logWarning(
                            "Failed to interrupt kernel after scratchpad stream was abandoned",
                          ).pipe(Effect.annotateLogs({ cause })),
                        ),
                      )
                  : Effect.void,
              );

              return Stream.fromQueue(subscription).pipe(
                Stream.filter(
                  (operation) => operation.notebookUri === notebookId,
                ),
                Stream.takeUntil(isCompletedRunFor(runId)),
                Stream.filterMap(({ operation }) =>
                  isScratchpadOutput(operation)
                    ? Option.some(operation)
                    : Option.none(),
                ),
              );
            }),
          ),
        updateUIElements: (request) =>
          marimo.updateUiElement({
            notebookUri: notebookId,
            inner: request,
          }),
        updateModel: (request) =>
          marimo.setModelValue({
            notebookUri: notebookId,
            inner: request,
          }),
        invokeFunction: (request) =>
          marimo.invokeFunction({
            notebookUri: notebookId,
            inner: request,
          }),
        deleteCell: (request) =>
          marimo.deleteCell({
            notebookUri: notebookId,
            inner: request,
          }),
        sendStdin: (request) =>
          marimo.sendStdin({
            notebookUri: notebookId,
            inner: request,
          }),
        interrupt: () =>
          marimo.interrupt({ notebookUri: notebookId, inner: {} }),
        close: () =>
          marimo.closeSession({ notebookUri: notebookId, inner: {} }),
      });

      const makeState = (notebookId: NotebookId): NotebookState => {
        const controller = Ref.unsafeMake<Option.Option<NotebookController>>(
          Option.none(),
        );
        return {
          controller,
          handle: makeHandle(notebookId, controller, TSemaphore.unsafeMake(1)),
        };
      };

      const stateForNotebook = (notebookId: NotebookId) => {
        const existing = notebooks.get(notebookId);
        if (existing !== undefined) return existing;

        const state = makeState(notebookId);
        notebooks.set(notebookId, state);
        return state;
      };

      const forNotebook = (notebookId: NotebookId) =>
        stateForNotebook(notebookId).handle;

      const updateKernelContext = Effect.fn(
        "NotebookRuntime.updateKernelContext",
      )(function* () {
        const activeNotebook = Option.filterMap(
          yield* code.window.getActiveNotebookEditor(),
          (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
        );
        const hasKernel =
          Option.isSome(activeNotebook) &&
          Option.isSome(
            yield* forNotebook(activeNotebook.value.id).getController(),
          );

        yield* code.commands.setContext("marimo.notebook.hasKernel", hasKernel);
      });

      yield* Effect.forkScoped(updateKernelContext());
      yield* Effect.forkScoped(
        code.window
          .activeNotebookEditorChanges()
          .pipe(Stream.runForEach(updateKernelContext)),
      );
      yield* Effect.forkScoped(
        code.workspace.notebookDocumentClosed().pipe(
          Stream.runForEach(
            Effect.fn("NotebookRuntime.releaseNotebook")(function* (document) {
              const notebook = MarimoNotebookDocument.tryFrom(document);
              if (Option.isNone(notebook)) return;
              notebooks.delete(notebook.value.id);
              yield* updateKernelContext();
            }),
          ),
        ),
      );
      yield* Effect.forkScoped(
        processRuntimeOperations(
          marimo
            .operations()
            .pipe(
              Stream.tap((operation) => PubSub.publish(operations, operation)),
            ),
          Effect.fn("NotebookRuntime.processOperation")(
            function* (message, options) {
              yield* processOperation(message, {
                forNotebook,
                ...options,
              }).pipe(
                Effect.annotateLogs({
                  notebookUri: message.notebookUri,
                  operation: message.operation.op,
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
            },
          ),
        ),
      );

      yield* Effect.forkScoped(
        renderer.messages().pipe(
          Stream.runForEach(({ editor, message }) =>
            Effect.gen(function* () {
              const notebook = MarimoNotebookDocument.from(editor.notebook);
              const handle = forNotebook(notebook.id);

              switch (message.command) {
                case "update-ui-element":
                  yield* handle.updateUIElements(message.params);
                  break;
                case "invoke-function":
                  yield* handle.invokeFunction(message.params);
                  break;
                case "set-model-value":
                  yield* handle.updateModel(message.params);
                  break;
                case "navigate-to-cell": {
                  const activeEditor =
                    yield* code.window.getActiveNotebookEditor();
                  if (Option.isNone(activeEditor)) {
                    yield* Effect.logWarning(
                      "No active notebook editor to navigate to cell",
                    );
                    break;
                  }

                  const cellIndex = MarimoNotebookDocument.from(
                    activeEditor.value.notebook,
                  )
                    .getCells()
                    .findIndex((cell) =>
                      Option.contains(cell.id, message.params.cellId),
                    );

                  if (cellIndex !== -1) {
                    activeEditor.value.revealRange(
                      new code.NotebookRange(cellIndex, cellIndex + 1),
                      code.NotebookEditorRevealType.InCenter,
                    );
                  }
                  break;
                }
                case "save-image":
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
                  break;
                case "copy-image": {
                  const dataUri = yield* resolveImageDataUri(
                    message.params.src,
                  ).pipe(Effect.option);
                  yield* renderer.postMessage(
                    {
                      op: "image-data-result",
                      requestId: message.params.requestId,
                      dataUri: Option.getOrNull(dataUri),
                    },
                    editor,
                  );
                  break;
                }
                default:
                  unreachable(message, "Unknown message from frontend");
              }
            }),
          ),
        ),
      );

      yield* Effect.forkScoped(
        code.workspace.notebookDocumentChanges().pipe(
          Stream.filterMap((event) =>
            Option.map(
              MarimoNotebookDocument.tryFrom(event.notebook),
              (notebook) => ({ ...event, notebook }),
            ),
          ),
          Stream.runForEach((event) =>
            syncCellIdentity(event, {
              code,
              executions,
              notebook: forNotebook(event.notebook.id),
            }),
          ),
        ),
      );

      return {
        attachController(
          notebookId: NotebookId,
          controller: NotebookController,
        ) {
          return Effect.gen(function* () {
            yield* Effect.uninterruptible(
              Effect.gen(function* () {
                yield* Ref.set(
                  stateForNotebook(notebookId).controller,
                  Option.some(controller),
                );
                yield* PubSub.publish(controllerSelections, {
                  notebookUri: notebookId,
                  controller,
                });
              }),
            );
            yield* updateKernelContext();
          });
        },
        controllerChanges() {
          return Stream.fromPubSub(controllerSelections);
        },
        forNotebook,
      };

      function findOpenNotebook(notebookId: NotebookId) {
        return Effect.gen(function* () {
          const documents = yield* code.workspace.getNotebookDocuments();
          const notebook = EffectArray.findFirst(
            EffectArray.getSomes(
              documents.map((raw) => MarimoNotebookDocument.tryFrom(raw)),
            ),
            (candidate) => candidate.id === notebookId,
          );
          if (Option.isNone(notebook)) {
            return yield* new NoActiveKernelError({ notebookUri: notebookId });
          }
          return notebook.value;
        });
      }
    }),
  },
) {}

/**
 * Processes operations in order with one worker per notebook.
 *
 * Operations received while a worker is busy form the next batch. Every
 * operation updates runtime state, but only the newest renderable output for
 * each cell in that batch is projected into VS Code.
 */
export function processRuntimeOperations<E, R>(
  operations: Stream.Stream<MarimoOperation>,
  process: (
    operation: MarimoOperation,
    options: { readonly renderCellOutput: boolean },
  ) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, R> {
  return Effect.scoped(
    Effect.gen(function* () {
      type Work = Option.Option<MarimoOperation>;
      const queues = new Map<NotebookId, Queue.Queue<Work>>();
      const workers: Array<Fiber.RuntimeFiber<void, E>> = [];

      const processBatch = (batch: ReadonlyArray<MarimoOperation>) => {
        // The newest op for a cell may carry no payload at all — marimo sends
        // state-only cell-ops (`stale_inputs`, `serialization`) that trail the
        // terminal `idle` op. Project the newest op that can actually render,
        // so a payload-less trailer never costs the cell its output.
        const renderIndex = new Map<NotebookCellId, number>();
        for (const [index, message] of batch.entries()) {
          const operation = message.operation;
          if (operation.op !== "cell-op") continue;
          if (
            operation.status === "idle" ||
            operation.output != null ||
            operation.console != null
          ) {
            renderIndex.set(operation.cell_id, index);
          }
        }

        return Effect.forEach(
          batch,
          (message, index) => {
            const operation = message.operation;
            return process(message, {
              renderCellOutput:
                operation.op !== "cell-op" ||
                renderIndex.get(operation.cell_id) === index,
            });
          },
          { discard: true },
        );
      };

      const runWorker = (queue: Queue.Queue<Work>) =>
        Effect.gen(function* () {
          while (true) {
            const first = yield* Queue.take(queue);
            if (Option.isNone(first)) return;

            const waiting = yield* Queue.takeAll(queue);
            const batch = [
              first.value,
              ...Chunk.toReadonlyArray(waiting).flatMap((item) =>
                Option.match(item, {
                  onNone: () => [],
                  onSome: (message) => [message],
                }),
              ),
            ];
            yield* processBatch(batch);

            if (Chunk.some(waiting, Option.isNone)) return;
          }
        });

      yield* operations.pipe(
        Stream.runForEach((message) =>
          Effect.gen(function* () {
            let queue = queues.get(message.notebookUri);
            if (queue === undefined) {
              queue = yield* Queue.unbounded<Work>();
              queues.set(message.notebookUri, queue);
              workers.push(yield* Effect.forkScoped(runWorker(queue)));
            }
            yield* Queue.offer(queue, Option.some(message));
          }),
        ),
      );

      yield* Effect.forEach(
        queues.values(),
        (queue) => Queue.offer(queue, Option.none()),
        { discard: true },
      );
      yield* Effect.forEach(workers, Fiber.join, { discard: true });
    }),
  );
}

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
  options: {
    forNotebook: (notebookId: NotebookId) => NotebookHandle;
    readonly renderCellOutput: boolean;
  },
) {
  return Effect.gen(function* () {
    const variables = yield* VariablesService;
    const datasources = yield* DatasourcesService;

    switch (operation.op) {
      case "variables":
        yield* variables.updateVariables(notebookUri, operation);
        break;
      case "variable-values":
        yield* variables.updateVariableValues(notebookUri, operation);
        break;
      case "data-source-connections":
        yield* datasources.updateConnections(notebookUri, operation);
        break;
      case "datasets":
        yield* datasources.updateDatasets(notebookUri, operation);
        break;
      case "sql-table-preview":
        yield* datasources.updateTablePreview(notebookUri, operation);
        break;
      case "sql-table-list-preview":
        yield* datasources.updateTableListPreview(notebookUri, operation);
        break;
      case "data-column-preview":
        yield* datasources.updateColumnPreview(notebookUri, operation);
        break;
      case "notebook-document-transaction":
        yield* applyTransactionToEditor(notebookUri, operation);
        break;
      case "cell-op":
      case "interrupted":
      case "missing-package-alert":
      case "remove-ui-elements":
      case "function-call-result":
      case "send-ui-element-message":
      case "model-lifecycle":
        yield* processNotebookOperation(notebookUri, operation, options);
        break;
      case "active-line":
      case "alert":
      case "banner":
      case "cache-cleared":
      case "cache-info":
      case "completed-run":
      case "completion-result":
      case "consumer-capabilities":
      case "data-source-discovery-result":
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
      case "validate-sql-result":
        break;
      default:
        yield* Effect.logWarning("Unknown operation");
        unreachable(operation, "Unknown operation");
    }
  });
}

function applyTransactionToEditor(
  notebookUri: NotebookId,
  operation: NotificationOf<"notebook-document-transaction">,
) {
  return Effect.gen(function* () {
    const editors = yield* NotebookEditorRegistry;
    const editor = yield* editors.getLastNotebookEditor(notebookUri);
    if (Option.isNone(editor)) {
      yield* Effect.logWarning(
        "No active notebook editor; dropping document transaction",
      );
      return;
    }

    const notebook = MarimoNotebookDocument.from(editor.value.notebook);
    yield* applyDocumentTransaction(notebook, operation.transaction);
  });
}

function processNotebookOperation(
  notebookUri: NotebookId,
  operation:
    | CellOperationNotification
    | NotificationOf<"interrupted">
    | NotificationOf<"missing-package-alert">
    | NotificationOf<"remove-ui-elements">
    | NotificationOf<"function-call-result">
    | NotificationOf<"send-ui-element-message">
    | NotificationOf<"model-lifecycle">,
  options: {
    forNotebook: (notebookId: NotebookId) => NotebookHandle;
    readonly renderCellOutput: boolean;
  },
) {
  return Effect.gen(function* () {
    const uv = yield* Uv;
    const code = yield* VsCode;
    const config = yield* Config;
    const editors = yield* NotebookEditorRegistry;
    const renderer = yield* NotebookRenderer;
    const executions = yield* CellExecutions;
    const envInvalidation = yield* PythonEnvInvalidation;
    const runPromise = Runtime.runPromise(yield* Effect.runtime());

    const editor = yield* editors.getLastNotebookEditor(notebookUri);
    if (Option.isNone(editor)) {
      yield* Effect.logWarning("No active notebook editor, skipping operation");
      return;
    }

    const controller = yield* options.forNotebook(notebookUri).getController();
    if (Option.isNone(controller)) {
      yield* Effect.logWarning("No active controller, skipping operation");
      return;
    }

    const notebook = MarimoNotebookDocument.from(editor.value.notebook);

    switch (operation.op) {
      case "cell-op": {
        if (extractCellIdFromCellMessage(operation) === SCRATCH_CELL_ID) {
          break;
        }
        yield* executions.handleOperation(operation, {
          editor: editor.value,
          controller: controller.value,
          renderOutput: options.renderCellOutput,
        });
        yield* Effect.fork(
          handleStdinPrompt(operation, options.forNotebook(notebookUri)),
        );
        break;
      }
      case "interrupted":
        yield* executions.handleInterrupt(editor.value);
        break;
      case "missing-package-alert":
        void runPromise(
          handleMissingPackageAlert(operation, notebook, controller.value).pipe(
            Effect.provideService(Uv, uv),
            Effect.provideService(VsCode, code),
            Effect.provideService(Config, config),
            Effect.provideService(PythonEnvInvalidation, envInvalidation),
          ),
        );
        break;
      case "remove-ui-elements":
      case "function-call-result":
      case "model-lifecycle":
        void runPromise(renderer.postMessage(operation, editor.value));
        break;
      case "send-ui-element-message":
        if (!isValueUpdateEcho(operation)) {
          void runPromise(renderer.postMessage(operation, editor.value));
        }
        break;
      default:
        unreachable(operation, "Unknown notebook operation");
    }
  });
}

function handleStdinPrompt(
  operation: CellOperationNotification,
  notebook: NotebookHandle,
) {
  return Effect.gen(function* () {
    const code = yield* VsCode;
    if (operation.console == null) return;

    for (const output of EffectArray.ensure(operation.console)) {
      if (output.channel !== "stdin") continue;

      const prompt = typeof output.data === "string" ? output.data : "";
      const result = yield* code.window.showInputBox({
        prompt: prompt || "input()",
        password: output.mimetype === "text/password",
      });

      if (Option.isSome(result)) {
        yield* notebook.sendStdin({ text: result.value });
      } else {
        yield* notebook.interrupt();
      }
    }
  });
}

function syncCellIdentity(
  event: {
    notebook: MarimoNotebookDocument;
    contentChanges: ReadonlyArray<{
      removedCells: ReadonlyArray<vscode.NotebookCell>;
      addedCells: ReadonlyArray<vscode.NotebookCell>;
    }>;
  },
  options: {
    code: VsCode;
    executions: CellExecutions;
    notebook: NotebookHandle;
  },
) {
  return Effect.gen(function* () {
    const removedCellIds = new Set<NotebookCellId>();
    const addedCellIds = new Set<NotebookCellId>();
    const edits: Array<vscode.NotebookEdit> = [];

    for (const change of event.contentChanges) {
      for (const rawCell of change.removedCells) {
        const cell = MarimoNotebookCell.from(rawCell);
        if (Option.isSome(cell.id)) removedCellIds.add(cell.id.value);
      }

      for (const rawCell of change.addedCells) {
        const cell = MarimoNotebookCell.from(rawCell);
        if (Option.isSome(cell.id)) {
          addedCellIds.add(cell.id.value);
        } else {
          edits.push(
            options.code.NotebookEdit.updateCellMetadata(
              cell.index,
              cell.buildRuntimeMetadataForInsertion({
                stableId: crypto.randomUUID(),
              }),
            ),
          );
        }
      }
    }

    if (edits.length > 0) {
      const edit = new options.code.WorkspaceEdit();
      edit.set(event.notebook.uri, edits);
      yield* options.code.workspace.applyEdit(edit);
    }

    for (const cellId of removedCellIds) {
      if (addedCellIds.has(cellId)) continue;

      yield* options.executions.forgetCell(event.notebook.id, cellId);
      yield* options.notebook.deleteCell({ cellId }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logWarning(
            "Failed to notify backend about cell deletion",
          ).pipe(
            Effect.annotateLogs({
              cause,
              notebookUri: event.notebook.id,
              cellId,
            }),
          ),
        ),
      );
    }
  });
}
