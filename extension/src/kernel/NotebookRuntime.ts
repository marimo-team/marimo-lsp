import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Filter,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  type SchemaError,
  type Scope,
  Semaphore,
  Stream,
  Array as EffectArray,
} from "effect";
import type * as vscode from "vscode";

import { unreachable } from "../assert.ts";
import { Config } from "../config/Config.ts";
import { SCRATCH_CELL_ID, SETUP_CELL_NAME } from "../constants.ts";
import { showErrorAndPromptLogs } from "../lib/showErrorAndPromptLogs.ts";
import {
  MarimoClient,
  type MarimoClientStartError,
  type MarimoCommandError,
} from "../lsp/MarimoClient.ts";
import { applyDocumentTransaction } from "../notebook/applyDocumentTransaction.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../notebook/NotebookRenderer.ts";
import {
  isOpenNotebookSession,
  makeNotebookSessions,
  type OpenNotebookSession,
} from "../notebook/NotebookSessions.ts";
import { DatasourcesService } from "../panel/datasources/DatasourcesService.ts";
import { SessionsService } from "../panel/sessions/SessionsService.ts";
import { VariablesService } from "../panel/variables/VariablesService.ts";
import { Constants } from "../platform/Constants.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { VsCode } from "../platform/VsCode.ts";
import { PythonEnvInvalidation } from "../python/PythonEnvInvalidation.ts";
import { Uv } from "../python/Uv.ts";
import {
  extractCellIdFromCellMessage,
  findNotebookCell,
  MarimoNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId as makeNotebookCellId,
  type NotebookCellId,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type {
  CellOperationNotification,
  MarimoOperation,
  NotificationOf,
} from "../types.ts";
import { CellExecutions, CellInput, type Drive } from "./CellExecutions.ts";
import { resolveImageDataUri, saveImageToDisk } from "./imageResolver.ts";
import {
  NotebookFileRootError,
  resolveNotebookFileRoot,
} from "./NotebookFileRoot.ts";
import { handleMissingPackageAlert } from "./operations.ts";

/**
 * Service shapes. A `Context.Service` class is the context key. Use
 * `Context.Service.Shape` to get the type of the service value.
 */
type MarimoClientService = Context.Service.Shape<typeof MarimoClient>;
type VsCodeService = Context.Service.Shape<typeof VsCode>;
type CellExecutionsService = Context.Service.Shape<typeof CellExecutions>;

type InnerRequest<K extends keyof MarimoClientService> =
  MarimoClientService[K] extends (params: infer Params) => unknown
    ? Params extends { readonly inner: infer Request }
      ? Request
      : never
    : never;

export interface NotebookController {
  readonly id: string;
  readonly executable?: string;
  readonly drive: (notebook: MarimoNotebookDocument) => Drive;
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
  readonly getController: Effect.Effect<Option.Option<NotebookController>>;
  readonly executeCells: (
    request: InnerRequest<"executeCells">,
    executable: string,
  ) => Effect.Effect<
    null,
    | MarimoClientStartError
    | MarimoCommandError
    | NoActiveKernelError
    | NotebookFileRootError
    | SchemaError.SchemaError
  >;
  readonly executeScratchpad: (
    code: string,
  ) => Stream.Stream<
    CellOperationNotification,
    | ExecutableResolutionError
    | MarimoClientStartError
    | MarimoCommandError
    | NoActiveKernelError
    | NotebookFileRootError
    | SchemaError.SchemaError
    | UnsavedNotebookError
  >;
  readonly updateUIElements: (
    request: InnerRequest<"updateUiElement">,
  ) => ReturnType<MarimoClientService["updateUiElement"]>;
  readonly updateModel: (
    request: InnerRequest<"setModelValue">,
  ) => ReturnType<MarimoClientService["setModelValue"]>;
  readonly invokeFunction: (
    request: InnerRequest<"invokeFunction">,
  ) => ReturnType<MarimoClientService["invokeFunction"]>;
  readonly deleteCell: (
    request: InnerRequest<"deleteCell">,
  ) => ReturnType<MarimoClientService["deleteCell"]>;
  readonly sendStdin: (
    request: InnerRequest<"sendStdin">,
  ) => ReturnType<MarimoClientService["sendStdin"]>;
  readonly interrupt: ReturnType<MarimoClientService["interrupt"]>;
  readonly close: ReturnType<MarimoClientService["closeSession"]>;
}

interface NotebookState {
  readonly handle: NotebookHandle;
  readonly controller: Ref.Ref<Option.Option<NotebookController>>;
}

type SessionOperation = MarimoOperation & {
  readonly session: OpenNotebookSession;
};

export interface RuntimeSession {
  readonly executable: string;
  readonly workingDirectory: string;
}

export interface RuntimeSessionEntry {
  readonly notebookId: NotebookId;
  readonly session: RuntimeSession;
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
 * yield* notebook.interrupt;
 * ```
 *
 * Commands still go directly through MarimoClient. This Module does not
 * schedule or merge them.
 */
export class NotebookRuntime extends Context.Service<NotebookRuntime>()(
  "NotebookRuntime",
  {
    make: Effect.gen(function* () {
      const code = yield* VsCode;
      const config = yield* Config;
      const marimo = yield* MarimoClient;
      const renderer = yield* NotebookRenderer;
      const executions = yield* CellExecutions;
      const variables = yield* VariablesService;
      const datasources = yield* DatasourcesService;
      const liveSessions = yield* SessionsService;
      const operations = yield* PubSub.unbounded<MarimoOperation>();
      const notebooks = new Map<NotebookId, NotebookState>();
      const runtimeSessions = new Map<NotebookId, RuntimeSession>();
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
        scratchpadLock: Semaphore.Semaphore,
      ): NotebookHandle => ({
        id: notebookId,
        getController: Ref.get(controller),
        executeCells: (request, executable) =>
          Effect.gen(function* () {
            const workingDirectory = yield* resolveWorkingDirectory(
              notebookId,
              executable,
            );
            const send = marimo.executeCells({
              notebookUri: notebookId,
              executable,
              workingDirectory,
              inner: request,
            });
            const result = yield* executions.submit(
              notebookId,
              request.cellIds.flatMap((cellId, index) => {
                const source = request.codes[index];
                return source === undefined
                  ? []
                  : [{ cellId: makeNotebookCellId(cellId), source }];
              }),
              send,
            );
            runtimeSessions.set(notebookId, {
              executable,
              workingDirectory,
            });
            return result;
          }),
        executeScratchpad: (sourceCode) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // Hold one permit for the lifetime of the stream's scope.
              yield* Effect.acquireRelease(scratchpadLock.take(1), () =>
                scratchpadLock.release(1),
              );

              const selectedController = yield* Ref.get(controller);
              if (Option.isNone(selectedController)) {
                return yield* new NoActiveKernelError({
                  notebookUri: notebookId,
                });
              }

              const notebook = yield* findOpenNotebook(notebookId);
              const executable =
                yield* selectedController.value.resolveExecutable(notebook);
              const workingDirectory = yield* resolveWorkingDirectory(
                notebookId,
                executable,
              );
              const subscription = yield* PubSub.subscribe(operations);
              const runId = crypto.randomUUID();

              // Arm the finalizer before sending the command. Cancellation of
              // the send remains prompt; its run id lets the server remember a
              // cancellation that arrives before session startup completes.
              yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer((exit) =>
                    Exit.hasInterrupts(exit)
                      ? marimo
                          .interrupt({
                            notebookUri: notebookId,
                            inner: { runId },
                          })
                          .pipe(
                            // You cannot interrupt a finalizer. Without a
                            // timeout, a dead server stops the cancel.
                            Effect.timeout("5 seconds"),
                            Effect.catchCause((cause) =>
                              Effect.logWarning(
                                "Failed to interrupt kernel after scratchpad stream was abandoned",
                              ).pipe(Effect.annotateLogs({ cause })),
                            ),
                          )
                      : Effect.void,
                  );

                  yield* restore(
                    marimo.executeScratchpad({
                      notebookUri: notebookId,
                      executable,
                      workingDirectory,
                      inner: { code: sourceCode, runId },
                    }),
                  );
                  runtimeSessions.set(notebookId, {
                    executable,
                    workingDirectory,
                  });
                }),
              );

              return Stream.fromSubscription(subscription).pipe(
                Stream.filter(
                  (operation) => operation.notebookUri === notebookId,
                ),
                Stream.takeUntil(isCompletedRunFor(runId)),
                Stream.filterMap(
                  Filter.fromPredicateOption(
                    ({ operation }: MarimoOperation) =>
                      isScratchpadOutput(operation)
                        ? Option.some(operation)
                        : Option.none(),
                  ),
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
        interrupt: marimo.interrupt({ notebookUri: notebookId, inner: {} }),
        close: marimo
          .closeSession({ notebookUri: notebookId, inner: {} })
          .pipe(
            Effect.tap(() =>
              Effect.sync(() => runtimeSessions.delete(notebookId)),
            ),
          ),
      });

      const makeState = (notebookId: NotebookId): NotebookState => {
        const controller = Ref.makeUnsafe<Option.Option<NotebookController>>(
          Option.none(),
        );
        return {
          controller,
          handle: makeHandle(notebookId, controller, Semaphore.makeUnsafe(1)),
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
        const activeNotebook = Option.flatMap(
          yield* code.window.getActiveNotebookEditor,
          (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
        );
        const hasKernel = Option.isSome(activeNotebook)
          ? Option.isSome(yield* liveSessions.find(activeNotebook.value.id))
          : false;

        yield* code.commands.setContext("marimo.notebook.hasKernel", hasKernel);
      });

      yield* Effect.forkScoped(updateKernelContext());
      yield* Effect.forkScoped(
        code.window.activeNotebookEditorChanges.pipe(
          Stream.runForEach(updateKernelContext),
        ),
      );
      const notebookSessions = yield* makeNotebookSessions(
        code,
        Effect.fn("NotebookRuntime.releaseNotebook")(function* (notebookId) {
          notebooks.delete(notebookId);
          yield* executions.accept(CellInput.Invalidated({ notebookId }));
          yield* variables.clearNotebook(notebookId);
          yield* datasources.clearNotebook(notebookId);
          yield* updateKernelContext();
        }),
      );
      yield* Effect.forkScoped(
        liveSessions.changes.pipe(Stream.runForEach(updateKernelContext)),
      );
      yield* Effect.forkScoped(
        processRuntimeOperations(
          marimo.operations
            .pipe(
              Stream.filterMap(
                Filter.fromPredicateOption((message: MarimoOperation) => {
                  const session = notebookSessions.current(message.notebookUri);
                  return isOpenNotebookSession(session)
                    ? Option.some<SessionOperation>({ ...message, session })
                    : Option.none();
                }),
              ),
            )
            .pipe(
              Stream.tap((operation) => PubSub.publish(operations, operation)),
            ),
          Effect.fn("NotebookRuntime.processOperation")(
            function* (message, options) {
              // The session is captured when the operation enters the runtime,
              // not when its per-notebook worker eventually processes it.
              // This keeps queued operations from an old session out of a
              // rapidly reopened notebook with the same URI.
              if (
                notebookSessions.current(message.notebookUri) !==
                message.session
              ) {
                return;
              }
              yield* Effect.annotateCurrentSpan(
                "operation.type",
                message.operation.op,
              );
              yield* Effect.raceFirst(
                processOperation(message, {
                  forNotebook,
                  session: message.session,
                  ...options,
                }).pipe(
                  Effect.catchCause(
                    Effect.fn(function* (cause) {
                      yield* Effect.logError(
                        "Failed to process marimo operation",
                      ).pipe(Effect.annotateLogs({ cause }));
                      yield* Effect.forkChild(
                        showErrorAndPromptLogs(
                          "Failed to process marimo operation.",
                        ),
                      );
                    }),
                  ),
                  Effect.annotateLogs({
                    "operation.type": message.operation.op,
                  }),
                ),
                Deferred.await(message.session.invalidated),
              );
            },
          ),
        ),
      );

      yield* Effect.forkScoped(
        renderer.messages.pipe(
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
                    yield* code.window.getActiveNotebookEditor;
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
                    Effect.catch((cause) =>
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
        code.workspace.notebookDocumentChanges.pipe(
          Stream.filterMap(
            Filter.fromPredicateOption(
              (event: vscode.NotebookDocumentChangeEvent) =>
                Option.map(
                  MarimoNotebookDocument.tryFrom(event.notebook),
                  (notebook) => ({ ...event, notebook }),
                ),
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
        controllerChanges: Stream.fromPubSub(controllerSelections),
        getRuntimeSession(notebookId: NotebookId) {
          return Effect.sync(() =>
            Option.fromNullishOr(runtimeSessions.get(notebookId)),
          );
        },
        getRuntimeSessions: Effect.sync(() =>
          Array.from(runtimeSessions, ([notebookId, session]) => ({
            notebookId,
            session,
          })),
        ),
        activeRuntimeSession: Effect.gen(function* () {
          const activeNotebook = Option.flatMap(
            yield* code.window.getActiveNotebookEditor,
            (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
          );
          if (Option.isNone(activeNotebook)) {
            return Option.none<RuntimeSession>();
          }
          return Option.fromNullishOr(
            runtimeSessions.get(activeNotebook.value.id),
          );
        }),
        forNotebook,
      };

      function findOpenNotebook(notebookId: NotebookId) {
        return Effect.gen(function* () {
          const documents = yield* code.workspace.getNotebookDocuments;
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

      function resolveWorkingDirectory(
        notebookId: NotebookId,
        executable: string,
      ) {
        return Effect.gen(function* () {
          const session = runtimeSessions.get(notebookId);
          if (session?.executable === executable) {
            return session.workingDirectory;
          }

          const notebook = yield* findOpenNotebook(notebookId);
          const configuredValue = yield* config.notebookFileRoot(notebook.uri);
          const resolution = yield* resolveNotebookFileRoot({
            configuredValue,
            notebookUri: notebook.uri,
            workspaceFolders: yield* code.workspace.getWorkspaceFolders,
          });
          if (resolution.usedFirstWorkspaceFallback) {
            yield* Effect.logInfo(
              "Untitled notebook has multiple workspace folders; using the first for ${fileDirname}",
            ).pipe(Effect.annotateLogs({ workingDirectory: resolution.path }));
          }
          return resolution.path;
        });
      }
    }),
  },
) {
  static readonly layer = Layer.effect(this, this.make).pipe(
    Layer.provide([
      Uv.layer,
      Config.layer,
      Constants.layer,
      OutputChannel.layer,
      VariablesService.layer,
      NotebookRenderer.layer,
      CellExecutions.layer,
      DatasourcesService.layer,
      NotebookEditorRegistry.layer,
      PythonEnvInvalidation.layer,
      SessionsService.layer,
    ]),
  );
}

/**
 * Processes operations in order with one worker per notebook.
 *
 * Operations received while a worker is busy form the next batch. Every
 * operation updates runtime state, but only the newest renderable output for
 * each cell in that batch is projected into VS Code.
 */
export function processRuntimeOperations<
  Operation extends MarimoOperation,
  E,
  R,
>(
  operations: Stream.Stream<Operation>,
  process: (
    operation: Operation,
    options: { readonly renderCellOutput: boolean },
  ) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E, Exclude<R, Scope.Scope>> {
  return Effect.scoped(
    Effect.gen(function* () {
      type Work = Option.Option<Operation>;
      const queues = new Map<NotebookId, Queue.Queue<Work>>();
      const workers: Array<Fiber.Fiber<void, E>> = [];

      const processBatch = (batch: ReadonlyArray<Operation>) => {
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

            // `Queue.clear` takes all buffered items and does not wait.
            // `Queue.takeAll` waits for a minimum of one item.
            const waiting = yield* Queue.clear(queue);
            const batch = [
              first.value,
              ...waiting.flatMap((item) =>
                Option.match(item, {
                  onNone: () => [],
                  onSome: (message) => [message],
                }),
              ),
            ];
            yield* processBatch(batch);

            if (waiting.some(Option.isNone)) return;
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
    readonly session: OpenNotebookSession;
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
      case "sql-schema-list-preview":
        yield* datasources.updateSchemaList(notebookUri, operation);
        break;
      case "sql-table-list-preview":
        yield* datasources.updateTableList(notebookUri, operation);
        break;
      case "notebook-document-transaction":
        yield* applyTransactionToEditor(
          notebookUri,
          operation,
          options.session.document,
        );
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
      case "data-column-preview":
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
      case "sql-table-preview":
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
  sessionDocument: vscode.NotebookDocument,
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
    if (editor.value.notebook !== sessionDocument) return;

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
    readonly session: OpenNotebookSession;
    readonly renderCellOutput: boolean;
  },
) {
  return Effect.gen(function* () {
    const editors = yield* NotebookEditorRegistry;
    const renderer = yield* NotebookRenderer;
    const executions = yield* CellExecutions;

    const forkForSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.forkDetach(
        Effect.raceFirst(
          effect,
          Deferred.await(options.session.invalidated),
        ).pipe(Effect.asVoid),
      );

    const editor = yield* editors.getLastNotebookEditor(notebookUri);
    if (Option.isNone(editor)) {
      yield* Effect.logWarning("No active notebook editor, skipping operation");
      return;
    }
    if (editor.value.notebook !== options.session.document) return;

    const controller = yield* options.forNotebook(notebookUri).getController;
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
        const cellId = extractCellIdFromCellMessage(operation);
        const cell = yield* findNotebookCell(notebook, cellId).pipe(
          Effect.option,
        );
        if (Option.isNone(cell)) {
          yield* Effect.logWarning(
            "Notebook cell not found for cell operation",
          ).pipe(Effect.annotateLogs({ cellId }));
          break;
        }
        yield* executions.accept(
          CellInput.Operation({
            notebookId: notebook.id,
            operation,
            drive: controller.value.drive(notebook),
            renderOutput: options.renderCellOutput,
          }),
        );
        yield* forkForSession(
          handleStdinPrompt(operation, options.forNotebook(notebookUri)),
        );
        break;
      }
      case "interrupted":
        yield* executions.accept(
          CellInput.Interrupted({ notebookId: notebook.id }),
        );
        break;
      case "missing-package-alert":
        yield* forkForSession(
          handleMissingPackageAlert(operation, notebook, controller.value),
        );
        break;
      case "remove-ui-elements":
      case "function-call-result":
      case "model-lifecycle":
        yield* renderer.postMessage(operation, editor.value);
        break;
      case "send-ui-element-message":
        if (!isValueUpdateEcho(operation)) {
          yield* renderer.postMessage(operation, editor.value);
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
        yield* notebook.interrupt;
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
    code: VsCodeService;
    executions: CellExecutionsService;
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
          // marimo reserves the cell id "setup" for the setup cell: the
          // kernel keys its setup-cell semantics on that exact id, and file
          // deserialization assigns it. Any other cell gets a fresh UUID.
          const isSetupCell =
            Option.isSome(cell.name) && cell.name.value === SETUP_CELL_NAME;
          edits.push(
            options.code.NotebookEdit.updateCellMetadata(
              cell.index,
              cell.buildRuntimeMetadataForInsertion({
                stableId: isSetupCell ? SETUP_CELL_NAME : crypto.randomUUID(),
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

    const removed = [...removedCellIds].filter(
      (cellId) => !addedCellIds.has(cellId),
    );
    yield* options.executions.accept(
      CellInput.CellsRemoved({
        notebookId: event.notebook.id,
        cellIds: removed,
      }),
    );

    for (const cellId of removed) {
      yield* options.notebook.deleteCell({ cellId }).pipe(
        Effect.catchCause((cause) =>
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
