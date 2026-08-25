import {
  Context,
  Data,
  Deferred,
  Effect,
  Exit,
  Filter,
  Layer,
  Option,
  PubSub,
  Ref,
  type SchemaError,
  Semaphore,
  Scope,
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
import {
  type NotebookDocumentSession,
  NotebookDocumentSessions,
} from "../notebook/NotebookDocumentSessions.ts";
import { NotebookEditorRegistry } from "../notebook/NotebookEditorRegistry.ts";
import { NotebookRenderer } from "../notebook/NotebookRenderer.ts";
import { readNotebookOutputs } from "../notebook/readNotebookOutputs.ts";
import { NotebookDatasources } from "../panel/datasources/NotebookDatasources.ts";
import { LiveSessions } from "../panel/sessions/LiveSessions.ts";
import { NotebookVariables } from "../panel/variables/NotebookVariables.ts";
import { Constants } from "../platform/Constants.ts";
import { OutputChannel } from "../platform/OutputChannel.ts";
import { VsCode } from "../platform/VsCode.ts";
import { PythonEnvInvalidation } from "../python/PythonEnvInvalidation.ts";
import { Uv } from "../python/Uv.ts";
import {
  extractCellIdFromCellMessage,
  MarimoNotebookCell,
  MarimoNotebookDocument,
  NotebookCellId as makeNotebookCellId,
  type NotebookCellId,
  type NotebookId,
} from "../schemas/MarimoNotebookDocument.ts";
import type {
  CellOutputReplay,
  KernelSessionId,
} from "../schemas/Models.gen.ts";
import type {
  CellOperationNotification,
  KernelNotification,
  NotificationOf,
} from "../types.ts";
import { CellExecutions, type Drive } from "./CellExecutions.ts";
import { resolveImageDataUri, saveImageToDisk } from "./imageResolver.ts";
import { makeNotebookExecutor } from "./NotebookExecutor.ts";
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
type LiveSessionsShape = Context.Service.Shape<typeof LiveSessions>;

type InnerRequest<K extends keyof MarimoClientService> =
  MarimoClientService[K] extends (params: infer Params) => unknown
    ? Params extends { readonly inner: infer Request }
      ? Request
      : never
    : never;

type WithNoActiveKernel<T> =
  T extends Effect.Effect<infer A, infer E, infer R>
    ? Effect.Effect<A, E | NoActiveKernelError, R>
    : never;

type RespondToStdin = (
  notebookId: NotebookId,
  sessionId: KernelSessionId,
  result: Option.Option<string>,
) => WithNoActiveKernel<ReturnType<MarimoClientService["sendStdin"]>>;

export interface NotebookController {
  readonly id: string;
  readonly executable?: string;
  readonly drive: (notebook: MarimoNotebookDocument) => Drive;
  readonly presentOutputs: (
    notebook: MarimoNotebookDocument,
    replays: ReadonlyArray<CellOutputReplay>,
  ) => Effect.Effect<void>;
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
  ) => WithNoActiveKernel<ReturnType<MarimoClientService["updateUiElement"]>>;
  readonly updateModel: (
    request: InnerRequest<"setModelValue">,
  ) => WithNoActiveKernel<ReturnType<MarimoClientService["setModelValue"]>>;
  readonly invokeFunction: (
    request: InnerRequest<"invokeFunction">,
  ) => WithNoActiveKernel<ReturnType<MarimoClientService["invokeFunction"]>>;
  readonly deleteCell: (
    request: InnerRequest<"deleteCell">,
  ) => WithNoActiveKernel<ReturnType<MarimoClientService["deleteCell"]>>;
  readonly interrupt: WithNoActiveKernel<
    ReturnType<MarimoClientService["interrupt"]>
  >;
  readonly restart: ReturnType<LiveSessionsShape["restart"]>;
  readonly close: ReturnType<LiveSessionsShape["shutdown"]>;
}

/** Operations scoped to one Notebook Document Session. */
export interface NotebookDocumentHandle {
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
}

interface NotebookState {
  readonly handle: NotebookHandle;
  readonly controller: Ref.Ref<Option.Option<NotebookController>>;
}

type SessionNotification = KernelNotification & {
  readonly session: NotebookDocumentSession;
};

export interface RuntimeSession {
  readonly executable: string;
  readonly workingDirectory: string;
}

export interface RuntimeSessionEntry {
  readonly notebookId: NotebookId;
  readonly session: RuntimeSession;
}

type RuntimeWorkRequirements =
  | CellExecutions
  | Config
  | Constants
  | NotebookDatasources
  | NotebookEditorRegistry
  | NotebookDocumentSessions
  | NotebookRenderer
  | OutputChannel
  | PythonEnvInvalidation
  | Uv
  | NotebookVariables
  | VsCode;

function hasRunId<T extends { run_id?: string | null }>(
  event: T,
): event is T & { run_id: string } {
  return typeof event.run_id === "string" && event.run_id.length > 0;
}

function isCompletedRunFor(runId: string) {
  return (message: KernelNotification) =>
    message.notification.op === "completed-run" &&
    hasRunId(message.notification) &&
    message.notification.run_id === runId;
}

function isScratchpadOutput(
  notification: KernelNotification["notification"],
): notification is CellOperationNotification {
  if (notification.op !== "cell-op") return false;
  if (notification.cell_id === SCRATCH_CELL_ID) return true;
  if (notification.console == null) return false;
  return EffectArray.ensure(notification.console).some(
    (output) => output.channel === "stdout" || output.channel === "stderr",
  );
}

/**
 * Owns notebook handles, controller selection, and kernel message handling.
 *
 * ```ts
 * const runtime = yield* NotebookRuntime;
 * const documentHandle = yield* runtime.forDocument(rawNotebook);
 * const notebook = yield* runtime.forNotebook(notebookId);
 *
 * yield* documentHandle.executeCells(request, executable);
 * yield* notebook.updateUIElements(update);
 * yield* notebook.interrupt;
 * ```
 *
 * Kernel work is admitted to one ordered executor per notebook.
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
      const variables = yield* NotebookVariables;
      const datasources = yield* NotebookDatasources;
      const liveSessions = yield* LiveSessions;
      const documentSessions = yield* NotebookDocumentSessions;
      const operations = yield* PubSub.unbounded<SessionNotification>();
      const notebookStates = new Map<
        NotebookId | NotebookDocumentSession,
        NotebookState
      >();
      const kernelSessions = new Map<NotebookId, KernelSessionId>(
        (yield* liveSessions.get).map((session) => [
          session.notebookUri,
          session.sessionId,
        ]),
      );
      const executor = yield* makeNotebookExecutor<RuntimeWorkRequirements>();
      const controllerSelections =
        yield* PubSub.unbounded<NotebookControllerSelection>();

      yield* Effect.addFinalizer(() =>
        Effect.all(
          [PubSub.shutdown(operations), PubSub.shutdown(controllerSelections)],
          { discard: true },
        ),
      );

      const reconcileKernelSession = Effect.fn(
        "NotebookRuntime.reconcileKernelSession",
      )(function* (notebookId: NotebookId) {
        const previous = kernelSessions.get(notebookId);
        const current = yield* liveSessions.find(notebookId);
        const next = Option.isSome(current)
          ? current.value.sessionId
          : undefined;
        if (previous === next) return;

        if (next === undefined) kernelSessions.delete(notebookId);
        else kernelSessions.set(notebookId, next);
        if (previous !== undefined) {
          yield* executions.invalidate(notebookId);
          yield* datasources.clearKernelSession(notebookId, previous);
        }
      });

      const runInNotebook = executor.submit;

      const runInKernelSession = <A, E, R extends RuntimeWorkRequirements>(
        notebookId: NotebookId,
        sessionId: KernelSessionId,
        effect: Effect.Effect<A, E, R>,
      ) =>
        runInNotebook(
          notebookId,
          Effect.gen(function* () {
            if (kernelSessions.get(notebookId) !== sessionId) {
              return yield* new NoActiveKernelError({
                notebookUri: notebookId,
              });
            }
            return yield* effect;
          }),
        );

      const runInCurrentKernelSession = <
        A,
        E,
        R extends RuntimeWorkRequirements,
      >(
        notebookId: NotebookId,
        effect: (sessionId: KernelSessionId) => Effect.Effect<A, E, R>,
      ) =>
        Effect.suspend(() => {
          const sessionId = kernelSessions.get(notebookId);
          if (sessionId === undefined) {
            return Effect.fail(
              new NoActiveKernelError({ notebookUri: notebookId }),
            );
          }
          return runInKernelSession(notebookId, sessionId, effect(sessionId));
        });

      const mutateKernelSession = <A, E>(
        notebookId: NotebookId,
        effect: Effect.Effect<A, E>,
      ) =>
        runInNotebook(
          notebookId,
          effect.pipe(Effect.tap(() => reconcileKernelSession(notebookId))),
        );

      const respondToStdin: RespondToStdin = (
        notebookId: NotebookId,
        sessionId: KernelSessionId,
        result: Option.Option<string>,
      ) =>
        runInKernelSession(
          notebookId,
          sessionId,
          Option.match(result, {
            onSome: (text) =>
              marimo.sendStdin({
                notebookUri: notebookId,
                sessionId,
                inner: { text },
              }),
            onNone: () =>
              marimo.interrupt({
                notebookUri: notebookId,
                inner: { sessionId },
              }),
          }),
        );

      const makeDocumentHandle = (
        session: NotebookDocumentSession,
        controller: Ref.Ref<Option.Option<NotebookController>>,
      ): NotebookDocumentHandle => ({
        executeCells: (request, executable) =>
          stateForDocumentSession(session).pipe(
            Effect.andThen(
              executor
                .submitScoped(
                  session.notebookId,
                  Effect.gen(function* () {
                    const notebookId = session.notebookId;
                    const notebook = MarimoNotebookDocument.from(
                      session.document,
                    );
                    const workingDirectory = yield* resolveWorkingDirectory(
                      notebookId,
                      executable,
                      notebook,
                    );
                    const send = marimo.executeCells({
                      notebookUri: notebookId,
                      executable,
                      workingDirectory,
                      inner: request,
                    });
                    const notebookExecutions = yield* executions.open(session, {
                      getDrive: Ref.get(controller).pipe(
                        Effect.map(
                          Option.map((selected) => selected.drive(notebook)),
                        ),
                      ),
                    });
                    const result = yield* notebookExecutions.submit(
                      request.cellIds.flatMap((cellId, index) => {
                        const source = request.codes[index];
                        return source === undefined
                          ? []
                          : [
                              {
                                cellId: makeNotebookCellId(cellId),
                                source,
                              },
                            ];
                      }),
                      send,
                    );
                    yield* liveSessions.refresh();
                    yield* reconcileKernelSession(notebookId);
                    return result;
                  }).pipe(
                    Effect.catchTag("NotebookDocumentSessionEndedError", () =>
                      Effect.fail(
                        new NoActiveKernelError({
                          notebookUri: session.notebookId,
                        }),
                      ),
                    ),
                  ),
                )
                .pipe(
                  Scope.provide(session.scope),
                  Effect.catchTag("NotebookExecutionScopeClosedError", () =>
                    Effect.fail(
                      new NoActiveKernelError({
                        notebookUri: session.notebookId,
                      }),
                    ),
                  ),
                ),
            ),
          ),
      });

      const makeHandle = (
        notebookId: NotebookId,
        controller: Ref.Ref<Option.Option<NotebookController>>,
        scratchpadLock: Semaphore.Semaphore,
      ): NotebookHandle => ({
        id: notebookId,
        getController: Ref.get(controller),
        executeScratchpad: (sourceCode) =>
          Stream.unwrap(
            Effect.gen(function* () {
              // Hold one permit for the lifetime of the stream's scope.
              yield* Effect.acquireRelease(scratchpadLock.take(1), () =>
                scratchpadLock.release(1),
              );
              const subscription = yield* PubSub.subscribe(operations);
              const runId = crypto.randomUUID();
              const abandoned = yield* Deferred.make<void>();

              // Register cancellation in the stream scope before the command
              // enters the notebook worker.
              yield* Effect.addFinalizer((exit) =>
                Exit.hasInterrupts(exit)
                  ? Deferred.succeed(abandoned, undefined).pipe(
                      Effect.andThen(
                        marimo
                          .interrupt({
                            notebookUri: notebookId,
                            inner: { runId },
                          })
                          .pipe(
                            Effect.timeout("5 seconds"),
                            Effect.catchCause((cause) =>
                              Effect.logWarning(
                                "Failed to interrupt kernel after scratchpad stream was abandoned",
                              ).pipe(Effect.annotateLogs({ cause })),
                            ),
                          ),
                      ),
                    )
                  : Effect.void,
              );

              return yield* runInNotebook(
                notebookId,
                Effect.raceFirst(
                  Effect.gen(function* () {
                    const selectedController = yield* Ref.get(controller);
                    if (Option.isNone(selectedController)) {
                      return yield* new NoActiveKernelError({
                        notebookUri: notebookId,
                      });
                    }

                    const session = documentSessions.current(notebookId);
                    if (Option.isNone(session)) {
                      return yield* new NoActiveKernelError({
                        notebookUri: notebookId,
                      });
                    }
                    const notebook = yield* findOpenNotebook(notebookId);
                    const executable =
                      yield* selectedController.value.resolveExecutable(
                        notebook,
                      );
                    const workingDirectory = yield* resolveWorkingDirectory(
                      notebookId,
                      executable,
                      notebook,
                    );
                    yield* marimo.executeScratchpad({
                      notebookUri: notebookId,
                      executable,
                      workingDirectory,
                      inner: { code: sourceCode, runId },
                    });
                    yield* liveSessions.refresh();
                    yield* reconcileKernelSession(notebookId);

                    return Stream.fromSubscription(subscription).pipe(
                      // Only output owned by the requesting document session;
                      // a reopened notebook's operations belong to a new one.
                      Stream.filter(
                        (operation) => operation.session === session.value,
                      ),
                      Stream.takeUntil(isCompletedRunFor(runId)),
                      Stream.filterMap(
                        Filter.fromPredicateOption(
                          ({ notification }: KernelNotification) =>
                            isScratchpadOutput(notification)
                              ? Option.some(notification)
                              : Option.none(),
                        ),
                      ),
                    );
                  }),
                  Deferred.await(abandoned).pipe(
                    Effect.andThen(Effect.interrupt),
                  ),
                ),
              );
            }),
          ),
        updateUIElements: (request) =>
          runInCurrentKernelSession(notebookId, (sessionId) =>
            marimo.updateUiElement({
              notebookUri: notebookId,
              sessionId,
              inner: request,
            }),
          ),
        updateModel: (request) =>
          runInCurrentKernelSession(notebookId, (sessionId) =>
            marimo.setModelValue({
              notebookUri: notebookId,
              sessionId,
              inner: request,
            }),
          ),
        invokeFunction: (request) =>
          runInCurrentKernelSession(notebookId, (sessionId) =>
            marimo.invokeFunction({
              notebookUri: notebookId,
              sessionId,
              inner: request,
            }),
          ),
        deleteCell: (request) =>
          runInCurrentKernelSession(notebookId, (sessionId) =>
            marimo.deleteCell({
              notebookUri: notebookId,
              sessionId,
              inner: request,
            }),
          ),
        interrupt: runInCurrentKernelSession(notebookId, (sessionId) =>
          marimo.interrupt({
            notebookUri: notebookId,
            inner: { sessionId },
          }),
        ),
        restart: mutateKernelSession(
          notebookId,
          liveSessions.restart(notebookId),
        ),
        close: mutateKernelSession(
          notebookId,
          liveSessions.shutdown(notebookId),
        ),
      });

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
      const makeState = (notebookId: NotebookId): NotebookState => {
        const controller = Ref.makeUnsafe<Option.Option<NotebookController>>(
          Option.none(),
        );
        return {
          controller,
          handle: makeHandle(notebookId, controller, Semaphore.makeUnsafe(1)),
        };
      };

      const stateForDocumentSession = Effect.fn(
        "NotebookRuntime.stateForDocumentSession",
      )((session: NotebookDocumentSession) =>
        Effect.uninterruptible(
          Effect.suspend(() => {
            const existing = notebookStates.get(session);
            if (existing !== undefined) return Effect.succeed(existing);

            const { notebookId } = session;
            const state = makeState(notebookId);
            notebookStates.delete(notebookId);
            notebookStates.set(session, state);
            return Scope.addFinalizer(
              session.scope,
              executor
                .post(
                  notebookId,
                  Effect.gen(function* () {
                    notebookStates.delete(session);
                    yield* updateKernelContext();
                  }),
                )
                .pipe(Effect.exit, Effect.asVoid),
            ).pipe(Effect.as(state));
          }),
        ),
      );

      const stateForNotebook = Effect.fn("NotebookRuntime.stateForNotebook")(
        (notebookId: NotebookId) =>
          Effect.suspend(() => {
            const session = documentSessions.current(notebookId);
            if (Option.isSome(session)) {
              return stateForDocumentSession(session.value);
            }

            const existing = notebookStates.get(notebookId);
            if (existing !== undefined) return Effect.succeed(existing);

            const state = makeState(notebookId);
            notebookStates.set(notebookId, state);
            return Effect.succeed(state);
          }),
      );

      const forNotebook = (notebookId: NotebookId) =>
        stateForNotebook(notebookId).pipe(Effect.map((state) => state.handle));

      yield* Effect.forkScoped(
        liveSessions.changes.pipe(
          Stream.runForEach((snapshot) =>
            Effect.gen(function* () {
              yield* updateKernelContext();
              const notebookIds = new Set<NotebookId>([
                ...kernelSessions.keys(),
                ...snapshot.map((session) => session.notebookUri),
              ]);
              yield* Effect.forEach(
                notebookIds,
                (notebookUri) =>
                  executor.post(
                    notebookUri,
                    reconcileKernelSession(notebookUri),
                  ),
                { discard: true },
              );
            }),
          ),
        ),
      );
      yield* Effect.forkScoped(
        marimo.kernelNotifications.pipe(
          Stream.filterMap(
            Filter.fromPredicateOption((message: KernelNotification) => {
              return Option.map(
                documentSessions.current(message.notebookUri),
                (session): SessionNotification => ({ ...message, session }),
              );
            }),
          ),
          Stream.runForEach((message) => {
            const run = (notebook: NotebookHandle) =>
              Effect.gen(function* () {
                // The kernel-session gate covers one race: sessionsChanged and
                // kernel notifications arrive on independent streams, so a
                // notification from a kernel replaced by restart can reach this
                // worker after the reconcile that installed the new session id.
                // The server never emits a stale id after announcing its
                // replacement on the wire; only this client-side reordering
                // needs guarding. (File-backed close/reopen reuses the same
                // kernel session, so no id change is involved there.)
                if (
                  kernelSessions.get(message.notebookUri) !== message.sessionId
                ) {
                  yield* liveSessions.refresh();
                  yield* reconcileKernelSession(message.notebookUri);
                }
                if (
                  kernelSessions.get(message.notebookUri) !== message.sessionId
                ) {
                  yield* Effect.logDebug(
                    "Ignored notification from an inactive kernel session",
                  ).pipe(
                    Effect.annotateLogs({
                      notebookUri: message.notebookUri,
                      sessionId: message.sessionId,
                      notification: message.notification.op,
                    }),
                  );
                  return;
                }

                yield* PubSub.publish(operations, message);
                yield* Effect.annotateCurrentSpan(
                  "notification.type",
                  message.notification.op,
                );
                yield* processOperation(message, {
                  notebook,
                  respondToStdin,
                  session: message.session,
                }).pipe(
                  Effect.catchTag(
                    "NotebookDocumentSessionEndedError",
                    () => Effect.void,
                  ),
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
                    "notification.type": message.notification.op,
                  }),
                );
              }).pipe(
                Effect.catchCause(
                  Effect.fn(function* (cause) {
                    yield* Effect.logError(
                      "Failed to coordinate marimo operation",
                    ).pipe(Effect.annotateLogs({ cause }));
                    yield* Effect.forkChild(
                      showErrorAndPromptLogs(
                        "Failed to process marimo operation.",
                      ),
                    );
                  }),
                ),
                Effect.withSpan("NotebookRuntime.processOperation"),
              );
            return stateForDocumentSession(message.session).pipe(
              Effect.flatMap((state) =>
                executor
                  .postScoped(message.notebookUri, run(state.handle))
                  .pipe(Scope.provide(message.session.scope)),
              ),
            );
          }),
        ),
      );
      yield* Effect.forkScoped(
        marimo.documentAnalysis.pipe(
          Stream.runForEach((message) => {
            const session = documentSessions.current(message.notebookUri);
            if (Option.isNone(session)) return Effect.void;
            return stateForDocumentSession(session.value).pipe(
              Effect.andThen(
                executor
                  .postScoped(
                    message.notebookUri,
                    variables.updateVariables(session.value, message.analysis),
                  )
                  .pipe(Scope.provide(session.value.scope)),
              ),
            );
          }),
        ),
      );

      yield* Effect.forkScoped(
        renderer.messages.pipe(
          Stream.runForEach(({ editor, message }) =>
            Effect.gen(function* () {
              const notebook = MarimoNotebookDocument.from(editor.notebook);
              const handle = yield* forNotebook(notebook.id);

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
            Effect.gen(function* () {
              const notebook = yield* forNotebook(event.notebook.id);
              yield* syncCellIdentity(event, {
                code,
                executions,
                notebook,
              });
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
                const state = yield* stateForNotebook(notebookId);
                yield* Ref.set(state.controller, Option.some(controller));
                yield* PubSub.publish(controllerSelections, {
                  notebookUri: notebookId,
                  controller,
                });
              }),
            );
            yield* updateKernelContext();

            const documentSession = documentSessions.current(notebookId);
            if (Option.isNone(documentSession)) return;
            const session = documentSession.value;
            const notebook = MarimoNotebookDocument.from(session.document);
            yield* readNotebookOutputs(notebook, marimo).pipe(
              Effect.flatMap(({ cells }) => {
                if (cells.length === 0 || session.document.isClosed) {
                  return Effect.void;
                }
                return executor
                  .submitScoped(
                    notebookId,
                    Effect.gen(function* () {
                      const state = yield* stateForDocumentSession(session);
                      const selected = yield* Ref.get(state.controller);
                      if (!Option.contains(selected, controller)) return;

                      const notebookExecutions = yield* executions.open(
                        session,
                        {
                          getDrive: Effect.succeed(
                            Option.some(controller.drive(notebook)),
                          ),
                        },
                      );
                      yield* Effect.forEach(
                        cells,
                        notebookExecutions.restoreOutput,
                        { discard: true },
                      );
                      yield* controller.presentOutputs(notebook, cells);
                    }),
                  )
                  .pipe(Scope.provide(session.scope));
              }),
              Effect.catchCause((cause) =>
                Effect.logDebug("Notebook output replay unavailable").pipe(
                  Effect.annotateLogs({ cause, notebookUri: notebookId }),
                ),
              ),
              Effect.forkIn(session.scope),
            );
          });
        },
        controllerChanges: Stream.fromPubSub(controllerSelections),
        getRuntimeSession(notebookId: NotebookId) {
          return liveSessions.find(notebookId).pipe(
            Effect.map(
              Option.map(({ executable, workingDirectory }) => ({
                executable,
                workingDirectory,
              })),
            ),
          );
        },
        getRuntimeSessions: liveSessions.get.pipe(
          Effect.map((sessions) =>
            sessions.map(({ notebookUri, executable, workingDirectory }) => ({
              notebookId: notebookUri,
              session: { executable, workingDirectory },
            })),
          ),
        ),
        activeRuntimeSession: Effect.gen(function* () {
          const activeNotebook = Option.flatMap(
            yield* code.window.getActiveNotebookEditor,
            (editor) => MarimoNotebookDocument.tryFrom(editor.notebook),
          );
          if (Option.isNone(activeNotebook)) {
            return Option.none<RuntimeSession>();
          }
          return Option.map(
            yield* liveSessions.find(activeNotebook.value.id),
            ({ executable, workingDirectory }) => ({
              executable,
              workingDirectory,
            }),
          );
        }),
        moveSession(notebookId: NotebookId, newNotebookId: NotebookId) {
          return runInNotebook(
            notebookId,
            liveSessions.move(notebookId, newNotebookId).pipe(
              Effect.tap(() => reconcileKernelSession(notebookId)),
              Effect.tap(() => reconcileKernelSession(newNotebookId)),
            ),
          );
        },
        restoreSession(
          notebookId: NotebookId,
          executable: string,
          workingDirectory: string,
        ) {
          return mutateKernelSession(
            notebookId,
            liveSessions.restore(notebookId, executable, workingDirectory),
          );
        },
        shutdownAll: Effect.gen(function* () {
          const current = yield* liveSessions.get;
          yield* Effect.forEach(
            current,
            (session) =>
              forNotebook(session.notebookUri).pipe(
                Effect.andThen((handle) => handle.close),
              ),
            { discard: true },
          );
        }),
        forDocument(document: vscode.NotebookDocument) {
          return Effect.gen(function* () {
            const session = documentSessions.forDocument(document);
            if (Option.isNone(session)) {
              const notebook = MarimoNotebookDocument.from(document);
              return yield* new NoActiveKernelError({
                notebookUri: notebook.id,
              });
            }
            const state = yield* stateForDocumentSession(session.value);
            return makeDocumentHandle(session.value, state.controller);
          });
        },
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
        openNotebook?: MarimoNotebookDocument,
      ) {
        return Effect.gen(function* () {
          const session = yield* liveSessions.find(notebookId);
          if (
            Option.isSome(session) &&
            session.value.executable === executable
          ) {
            return session.value.workingDirectory;
          }

          const notebook =
            openNotebook ?? (yield* findOpenNotebook(notebookId));
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
      NotebookVariables.layer,
      NotebookRenderer.layer,
      CellExecutions.layer,
      NotebookDatasources.layer,
      NotebookEditorRegistry.layer,
      PythonEnvInvalidation.layer,
      LiveSessions.layer,
      NotebookDocumentSessions.layer,
    ]),
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
  message: SessionNotification,
  options: {
    readonly notebook: NotebookHandle;
    readonly respondToStdin: RespondToStdin;
    readonly session: NotebookDocumentSession;
  },
) {
  return Effect.gen(function* () {
    const { notebookUri, notification: operation, sessionId } = message;
    const variables = yield* NotebookVariables;
    const datasources = yield* NotebookDatasources;

    switch (operation.op) {
      case "variables":
        yield* variables.updateVariables(options.session, operation);
        break;
      case "variable-values":
        yield* variables.updateVariableValues(options.session, operation);
        break;
      case "data-source-connections":
        yield* datasources.updateConnections(
          options.session,
          sessionId,
          operation,
        );
        break;
      case "datasets":
        yield* datasources.updateDatasets(
          options.session,
          sessionId,
          operation,
        );
        break;
      case "sql-schema-list-preview":
        yield* datasources.updateSchemaList(
          options.session,
          sessionId,
          operation,
        );
        break;
      case "sql-table-list-preview":
        yield* datasources.updateTableList(
          options.session,
          sessionId,
          operation,
        );
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
        yield* processNotebookOperation(notebookUri, operation, {
          ...options,
          kernelSessionId: sessionId,
        });
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
    readonly notebook: NotebookHandle;
    readonly respondToStdin: RespondToStdin;
    readonly session: NotebookDocumentSession;
    readonly kernelSessionId: KernelSessionId | undefined;
  },
) {
  return Effect.gen(function* () {
    const editors = yield* NotebookEditorRegistry;
    const renderer = yield* NotebookRenderer;
    const executions = yield* CellExecutions;
    const sessionNotebook = MarimoNotebookDocument.from(
      options.session.document,
    );
    const notebookExecutions = yield* executions.open(options.session, {
      getDrive: options.notebook.getController.pipe(
        Effect.map(
          Option.map((controller) => controller.drive(sessionNotebook)),
        ),
      ),
    });

    const forkForSession = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      Effect.forkIn(effect, options.session.scope).pipe(Effect.asVoid);

    if (operation.op === "cell-op") {
      if (extractCellIdFromCellMessage(operation) === SCRATCH_CELL_ID) return;
      yield* notebookExecutions.apply(operation).pipe(
        Effect.catchTag("RunCorrelationError", (error) =>
          Effect.logWarning(
            "Withheld presentation for uncorrelated cell operation",
          ).pipe(
            Effect.annotateLogs({
              cellId: error.cellId,
              expectedRunId: error.expectedRunId,
              receivedRunId: error.receivedRunId,
              status: error.status,
              reason: error.reason,
            }),
          ),
        ),
      );
      if (options.kernelSessionId === undefined) {
        yield* Effect.logWarning("Cell operation has no Kernel Session ID");
        return;
      }
      yield* forkForSession(
        handleStdinPrompt(
          operation,
          notebookUri,
          options.kernelSessionId,
          options.respondToStdin,
        ),
      );
      return;
    }

    if (operation.op === "interrupted") {
      yield* notebookExecutions.interrupt;
      return;
    }

    const editor = yield* editors.getLastNotebookEditor(notebookUri);
    if (Option.isNone(editor)) {
      yield* Effect.logWarning("No active notebook editor, skipping operation");
      return;
    }
    if (editor.value.notebook !== options.session.document) return;

    const controller = yield* options.notebook.getController;
    if (Option.isNone(controller)) {
      yield* Effect.logWarning("No active controller, skipping operation");
      return;
    }

    const notebook = MarimoNotebookDocument.from(editor.value.notebook);

    switch (operation.op) {
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
  notebookId: NotebookId,
  sessionId: KernelSessionId,
  respond: RespondToStdin,
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

      yield* respond(notebookId, sessionId, result);
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
    for (const cellId of removed) {
      const notebookExecutions = options.executions.find(
        event.notebook.rawNotebookDocument,
      );
      if (Option.isSome(notebookExecutions)) {
        yield* notebookExecutions.value.remove(cellId);
      }
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
